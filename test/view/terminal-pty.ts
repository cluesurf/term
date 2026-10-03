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
type App = { name: string; program: string; columns: number; rows: number; keys: string[]; want: string[]; backends: Backend[] }

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

const APPS: App[] = [
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

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/dom$/, 'native/terminal/dom'), fromFile)
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
import fcntl, os, pty, select, struct, sys, termios
columns, rows, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, master = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
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
            os.write(master, data)
        else:
            reading = False
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`

// run `command` in a pseudo-terminal of the app's size, type its keys once the screen is up, then ctrl-c
function inTerminal(command: string[], app: App): Promise<{ status: number | null; output: string }> {
  const child = spawn('python3', ['-c', PTY, String(app.columns), String(app.rows), ...command], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let typing = false

  return new Promise(done => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)

    child.stdout.on('data', chunk => {
      output += String(chunk)

      // the first screen is up once the app has cleared it: type then, a key at a time, and stop with ctrl-c
      if (!typing && output.includes(`${ESC}[2J`)) {
        typing = true
        const keys = [...app.keys, '\u0003']
        keys.forEach((key, i) => setTimeout(() => child.stdin.write(key), 300 + i * 200))
      }
    })

    child.on('close', status => {
      clearTimeout(timer)
      done({ status, output })
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
    const screen = replay(ran.output, app)
    ok(`${label}: it ends on ctrl-c with status 0`, ran.status === 0, `status ${ran.status}: ${JSON.stringify(ran.output.slice(-300))}`)
    ok(`${label}: it hides the cursor while it runs and shows it again when it leaves`, ran.output.includes(`${ESC}[?25l`) && ran.output.includes(`${ESC}[?25h`))
    ok(`${label}: the keys typed into the terminal leave the screen worked out by hand`, JSON.stringify(screen) === JSON.stringify(app.want), JSON.stringify(screen))
  }
}

console.log(`\nterminal-pty: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
