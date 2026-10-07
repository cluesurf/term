// A program that owns a real terminal (terminal-target-0006, deck/site/code/dom/native/terminal/app.tree): the note form
// built for node and as a Rust binary, run inside a pseudo-terminal (Python's `pty`) sized to 30 by 6, typed into the way
// a person would, one key at a time once the first screen is up. What comes back is the program's escape sequences,
// replayed here on a minimal screen (cursor placement, clear to the end of a row, clear the screen), and the screen it
// leaves must be the one worked out by hand. This is the only test that reaches raw mode, the terminal's size and real
// key bytes: every other terminal test paints to text.
// Run: npx tsx test/view/terminal-pty.ts   (TERMINAL_ONLY=rust for one backend)

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import type { Resolver } from '@term/make/code/compile/load'
import { buildOn } from '../compile/shared/run-on'
import type { Backend } from '../compile/shared/run-on'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const ESC = '\u001b'

// the blog's golden grid, kept with the project it proves (terminal-target-0005)
const BLOG_GOLDEN = join(import.meta.dirname, '../../../../../../note/term/project/terminal-target/blog.golden')

// an app run in a terminal: its program, the terminal's size, the keys typed once its screen is up (ctrl-c follows),
// the screen it must leave, and the backends it runs on
// `transcript`: for a line-mode app (native-accessibility-0005), the lines its output must hold in this order, checked
// in place of a replayed screen
type App = {
  name: string
  program: string
  columns: number
  rows: number
  keys: string[]
  want: string[]
  backends: Backend[]
  transcript?: string[]
  // the size a 0x1d among the keys resizes the terminal to, `columns`x`rows`
  resize?: string
  // how the app is stopped: ctrl-c typed (the default), or SIGTERM sent to it, and the status it must end with
  stop?: { key: string; status: number }
  // judge the screen as it stood before the stop was sent, rather than as the app left it: the paint that follows a
  // stop would otherwise hide a paint that should have come earlier
  settled?: boolean
  // run the program under job control, as a shell would, so a stop it sends itself really stops it (see PTY). An empty
  // key among the keys types nothing and only waits its turn
  jobs?: boolean
  // text the output must hold, in this order
  heard?: string[]
}

// ctrl-c, and the status a program it stops ends with
const CTRL_C = { key: '\u0003', status: 0 }

// a byte the relay never types: it sends SIGTERM to the program instead, as `kill` would
const TERM_KEY = '\u001c'

const NOTES_PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text
  find attach-event
  find render-each

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/terminal/dom
  find create-element
  find get-value
  find set-value

load @term/site/code/dom/native/terminal/app
  find run-terminal

load @term/base/code/list
  find list
  find push

task make-notes
  like list
    like text
  send back
    make list

task add-note
  take items
    like list
      like text
  take note, like text
  like list
    like text
  save out, call make-notes
  walk list, read items
    hook next
      take site, name item
      call push
        bind list, read out
        bind item, read item
  call push
    bind list, read out
    bind item, read note
  send back, read out

task current-notes
  take items, like signal
  like list
    like text
  send back
    call read-signal
      bind self, read items

view notes
  take host, like view
  save draft
    call make-signal
      bind value, text <>
  save items
    call make-signal
      bind value, call make-notes
  view div
    bind style, text <display: flex; flex-direction: row; gap: 8px>
    view input
      name field
      bind placeholder, text <note>
      seed input
        call write-signal
          bind self, read draft
          bind value
            call get-value
              read field
    view button
      seed click
        call write-signal
          bind self, read items
          bind value
            call add-note
              call read-signal
                bind self, read items
              call read-signal
                bind self, read draft
        call set-value
          read field
          text <>
        call write-signal
          bind self, read draft
          bind value, text <>
      text <add>
  walk list, call current-notes(read items)
    hook next
      take site, name item
      view p
        read item

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call notes
    read root
  call run-terminal
    read root
  send back, text <>
`

// the blog (deck/site/test/site/face/blog.tree) unchanged: face's stacks and texts, two fields, a button, and a store
// that is asynchronous, so a post appears only once work started by the click has finished
const BLOG_PROGRAM = `load @term/site/test/site/face/blog
  find blog

load @term/site/test/site/back/model
  find post

load @term/site/code/dom/native/terminal/dom
  find create-element

load @term/site/code/dom/native/terminal/app
  find run-terminal

load @term/base/code/list
  find list

task make-posts
  like list
    like post
  send back
    make list

# the store: keeps nothing, and answers later, as a database over a bridge would
task keep-nothing
  take item, like post
  mark async
  save kept, read item/title

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call blog
    read root
    call make-posts
    read keep-nothing
  call run-terminal
    read root
  send back, text <>
`

// the note app again, in line mode: the same view, owned by `run-terminal-lines`
const LINES_PROGRAM = NOTES_PROGRAM.replace('  find run-terminal\n', '  find run-terminal-lines\n').replace(
  '  call run-terminal\n    read root\n',
  '  call run-terminal-lines\n    read root\n',
)

const APPS: App[] = [
  {
    // the window narrowed to 10 columns while the app runs, then tab: the app clears and paints again at the new size.
    // The focused field takes 3 cells and the gap 1, so the button's `[ add ]` has 6 left and wraps there
    name: 'resize',
    program: NOTES_PROGRAM,
    columns: 30,
    rows: 6,
    keys: ['\u001d', '\t'],
    resize: '10x6',
    want: ['>█< [ add', '    ]', '', '', '', ''],
    backends: ['typescript', 'rust'],
  },
  {
    // the window narrowed and NO key after it: the resize itself wakes the waiting read and the app repaints before
    // ctrl-c is sent. The field takes 7 cells and the gap 1, so `[ add ]` has 2 left: `[`, then `add` broken at the
    // edge as `ad` and `d`, then `]`
    name: 'resize-now',
    program: NOTES_PROGRAM,
    columns: 30,
    rows: 6,
    keys: ['\u001d'],
    resize: '10x6',
    want: ['[note ] [', '        ad', '        d', '        ]', '', ''],
    backends: ['typescript', 'rust'],
    settled: true,
  },
  {
    // tab, `h`, then SIGTERM rather than ctrl-c: the app stops as ctrl-c stops it, raw mode off and the cursor shown,
    // and ends with 143, which is 128 plus SIGTERM's 15, as a process the signal had killed would
    name: 'sigterm',
    program: NOTES_PROGRAM,
    columns: 30,
    rows: 6,
    keys: ['\t', 'h'],
    want: ['>h█< [ add ]', '', '', '', '', ''],
    backends: ['typescript', 'rust'],
    stop: { key: TERM_KEY, status: 143 },
  },
  {
    // tab, `h`, ctrl-z: the app gives the terminal back (the cursor shown) and stops itself; the shell says [stopped],
    // then resumes it; the app takes raw mode again and redraws, and `i`, typed after, arrives as a key rather than
    // waiting in a line for enter. The field holds `hi`, and ctrl-c still ends it with status 0, so raw mode was
    // really taken back (without it ctrl-c is SIGINT, not a byte)
    name: 'suspend',
    program: NOTES_PROGRAM,
    columns: 30,
    rows: 6,
    keys: ['\t', 'h', '\u001a', '', '', '', 'i'],
    want: ['>hi█< [ add ]', '', '', '', '', ''],
    backends: ['typescript', 'rust'],
    jobs: true,
    heard: [`${ESC}[?25h`, '[stopped]', `${ESC}[?25l${ESC}[2J`],
  },
  {
    // the same keys as the note app below. Each round writes the rows that changed as plain lines and, when focus
    // moves or what it holds changes, what has it in the contract's words. Enter leaves focus on the button, unsaid
    name: 'lines',
    program: LINES_PROGRAM,
    columns: 30,
    rows: 6,
    keys: ['\t', 'h', 'i', '\t', '\r'],
    want: [],
    backends: ['typescript', 'rust'],
    transcript: [
      '[note ] [ add ]',
      '>█< [ add ]',
      'focus: field note: ',
      '>h█< [ add ]',
      'focus: field note: h',
      '>hi█< [ add ]',
      'focus: field note: hi',
      // tab: the field, unfocused, still holds `hi`, and the button has focus
      '[hi ] > add <',
      'focus: button add',
      // enter: the note added and the field cleared, focus where it was and so unsaid
      '[note ] > add <',
      'hi',
    ],
  },
  {
    // tab to the field, type `hi`, tab to the button, enter: the note is added, the field cleared, the button focused
    name: 'notes',
    program: NOTES_PROGRAM,
    columns: 30,
    rows: 6,
    keys: ['\t', 'h', 'i', '\t', '\r'],
    want: ['[note ] > add <', 'hi', '', '', '', ''],
    backends: ['typescript', 'rust'],
  },
  {
    // a title, a body, tab to the button, enter. Face's stack is a column with an 8 point gap (one blank row), the
    // fields have no placeholder (`[ ]`), and the post is a stack of an h2 and a span. The fields are cleared and focus
    // stays on the button. The click `tick`s an asynchronous task: node's loop yields for it, and Rust's queues it and
    // drains the queue (compile/rust.ts `__term_spawn`, `__term_drain`)
    // The screen is the project's golden grid, note/term/project/terminal-target/blog.golden, one row per line
    name: 'blog',
    program: BLOG_PROGRAM,
    columns: 30,
    rows: 10,
    keys: ['\t', 'H', 'i', '\t', 'y', 'o', '\t', '\r'],
    want: readFileSync(BLOG_GOLDEN, 'utf8').split('\n').slice(0, 10),
    backends: ['typescript', 'rust'],
  },
]

function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/(dom|view)$/, 'native/terminal/$1'), fromFile)
}

// the screen a stream of output leaves: printable code points at the cursor, CR, LF, and the three controls the app
// writes (`ESC [ row ; column H`, `ESC [ K`, `ESC [ 2 J`). Anything else is skipped
function replay(output: string, { rows: ROWS, columns: COLUMNS }: { rows: number; columns: number }): string[] {
  const screen = Array.from({ length: ROWS }, () => Array<string>(COLUMNS).fill(' '))
  const runes = [...output]
  let row = 0
  let column = 0

  for (let i = 0; i < runes.length; i++) {
    const rune = runes[i]!

    if (rune === ESC && runes[i + 1] === '[') {
      let at = i + 2
      let parameters = ''

      while (at < runes.length && !/[@-~]/.test(runes[at]!)) {
        parameters += runes[at]
        at++
      }

      const final = runes[at]
      const numbers = parameters.replace('?', '').split(';').map(n => Number(n) || 0)

      if (final === 'H' && !parameters.startsWith('?')) {
        row = Math.min(ROWS - 1, Math.max(0, (numbers[0] || 1) - 1))
        column = Math.min(COLUMNS - 1, Math.max(0, (numbers[1] || 1) - 1))
      } else if (final === 'K') {
        for (let c = column; c < COLUMNS; c++) {
          screen[row]![c] = ' '
        }
      } else if (final === 'J' && numbers[0] === 2) {
        screen.forEach(line => line.fill(' '))
      }

      i = at
    } else if (rune === '\r') {
      column = 0
    } else if (rune === '\n') {
      row = Math.min(ROWS - 1, row + 1)
    } else if (rune >= ' ') {
      if (column < COLUMNS) {
        screen[row]![column] = rune
      }

      column++
    }
  }

  return screen.map(line => line.join('').trimEnd())
}

// A pseudo-terminal from Python's own `pty`, because macOS `script` refuses to start when its input is a pipe
// ("tcgetattr/ioctl: Operation not supported on socket"). The child gets the terminal's slave as its input and output,
// sized before it starts, and the parent relays bytes both ways until the child's side closes, then exits with the
// child's status
const PTY = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
columns, rows, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, master = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    if os.environ.get('TERM_JOBS'):
        # job control, as a shell does it. The pty's session leader is this process, and a session leader's own group
        # is orphaned, where the kernel discards a stop (SIGTSTP). So the program runs in a group of its own, in the
        # foreground, and this process waits on it: on a stop it takes the terminal back, says [stopped], and after a
        # moment hands the terminal over again and resumes the group, as \`fg\` does
        ready, go = os.pipe()
        job = os.fork()
        if job == 0:
            os.setpgid(0, 0)
            os.read(ready, 1)
            os.execvp(command[0], command)
        os.setpgid(job, job)
        signal.signal(signal.SIGTTOU, signal.SIG_IGN)
        os.tcsetpgrp(0, job)
        os.write(go, b'.')
        while True:
            _, status = os.waitpid(job, os.WUNTRACED)
            if os.WIFSTOPPED(status):
                os.tcsetpgrp(0, os.getpgrp())
                os.write(1, b'[stopped]\\r\\n')
                time.sleep(0.3)
                os.tcsetpgrp(0, job)
                os.kill(-job, signal.SIGCONT)
                continue
            os._exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
    os.execvp(command[0], command)
reading = True
while True:
    ready, _, _ = select.select([master] + ([0] if reading else []), [], [], 0.1)
    if master in ready:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if reading and 0 in ready:
        data = os.read(0, 1024)
        if data:
            # 0x1d resizes the terminal to TERM_RESIZE (columns x rows) and tells the program, as a window drag does;
            # it is not typed
            if b'\\x1d' in data and os.environ.get('TERM_RESIZE'):
                wide, tall = (int(n) for n in os.environ['TERM_RESIZE'].split('x'))
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', tall, wide, 0, 0))
                os.kill(pid, signal.SIGWINCH)
                data = data.replace(b'\\x1d', b'')
            # 0x1c sends SIGTERM, as \`kill\` would; it is not typed
            if b'\\x1c' in data:
                os.kill(pid, signal.SIGTERM)
                data = data.replace(b'\\x1c', b'')
            if data:
                os.write(master, data)
        else:
            reading = False
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`

// run `command` in a pseudo-terminal of the app's size, type its keys once the screen is up, then stop it. `before` is
// the output that had come back when the stop was sent
function inTerminal(command: string[], app: App): Promise<{ status: number | null; output: string; before: string }> {
  const child = spawn('python3', ['-c', PTY, String(app.columns), String(app.rows), ...command], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM_RESIZE: app.resize ?? '', TERM_JOBS: app.jobs ? '1' : '' },
  })
  let output = ''
  let before = ''
  let typing = false

  return new Promise(done => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)

    child.stdout.on('data', chunk => {
      output += String(chunk)

      // the first screen is up once the app has cleared it: type then, a key at a time, and stop with ctrl-c
      // a line-mode app clears nothing, so its first line is the cue
      if (!typing && (output.includes(`${ESC}[2J`) || (app.transcript !== undefined && output.includes('\n')))) {
        typing = true
        const stop = (app.stop ?? CTRL_C).key
        const keys = [...app.keys, stop]
        keys.forEach((key, i) =>
          setTimeout(() => {
            if (key === stop) {
              before = output
            }

            if (key !== '') {
              child.stdin.write(key)
            }
          }, 300 + i * 200),
        )
      }
    })

    child.on('close', status => {
      clearTimeout(timer)
      done({ status, output, before })
    })
  })
}

const dir = mkdtempSync(join(tmpdir(), 'term-terminal-pty-'))
const only = process.env.TERMINAL_ONLY ?? ''
const hasPty = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0

for (const app of APPS) {
  for (const backend of app.backends.filter(b => !only || b === only)) {
    const label = `${backend} ${app.name}`

    if (!hasPty) {
      console.log(`skip  ${label}: no python3 with \`pty\` to make a pseudo-terminal`)
      continue
    }

    const built = buildOn({ backend, program: app.program, resolve: pinned, dir, name: app.name })

    if (built.form === 'skipped') {
      console.log(`skip  ${label}: ${built.reason}`)
      continue
    }

    ok(`${label}: compiles and builds against the terminal`, built.form === 'built', built.form === 'failed' ? `${built.stage}: ${built.reason}` : '')

    if (built.form !== 'built') {
      continue
    }

    const ran = await inTerminal(built.command, app)
    const stop = app.stop ?? CTRL_C
    const stopName = stop === CTRL_C ? 'ctrl-c' : 'SIGTERM'
    ok(`${label}: it ends on ${stopName} with status ${stop.status}`, ran.status === stop.status, `status ${ran.status}: ${JSON.stringify(ran.output.slice(-300))}`)

    if (app.transcript) {
      // line mode: plain lines only, no control sequence a reader would have to skip, and the expected lines in order
      const lines = ran.output.split(/\r?\n/).map(line => line.replace(/\r/g, ''))
      ok(`${label}: no control sequences, only lines`, !ran.output.includes(ESC), JSON.stringify(ran.output.slice(0, 200)))
      let at = 0
      const missing = app.transcript.find(want => {
        const found = lines.indexOf(want, at)

        if (found < 0) {
          return true
        }

        at = found + 1

        return false
      })
      ok(`${label}: every change and every focus move is a line, in order`, missing === undefined, `missing ${JSON.stringify(missing)} in ${JSON.stringify(lines)}`)
      continue
    }

    if (app.heard) {
      let at = 0
      const missing = app.heard.find(want => {
        const found = ran.output.indexOf(want, at)

        if (found < 0) {
          return true
        }

        at = found + want.length

        return false
      })
      ok(`${label}: the output holds what it must, in order`, missing === undefined, `missing ${JSON.stringify(missing)}`)
    }

    const screen = replay(app.settled ? ran.before : ran.output, app)
    // shown again AFTER the stop: the cursor is the visible half of giving the terminal back
    const shownAgain = ran.output.slice(ran.before.length).includes(`${ESC}[?25h`)
    ok(`${label}: it hides the cursor while it runs and shows it again when it leaves`, ran.output.includes(`${ESC}[?25l`) && shownAgain)
    const judged = app.settled ? ran.before : ran.output
    const lastClear = judged.lastIndexOf(`${ESC}[2J`)
    ok(
      `${label}: the keys typed into the terminal leave the screen worked out by hand`,
      JSON.stringify(screen) === JSON.stringify(app.want),
      `${JSON.stringify(screen)} from ${JSON.stringify(judged.slice(Math.max(0, lastClear)).slice(0, 400))}`,
    )
  }
}

console.log(`\nterminal-pty: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
