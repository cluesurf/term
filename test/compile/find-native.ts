// The find construct against a real tool on this machine (note/project/term/find, item 0008, mac section).
//
// A Term program that mounts `find pane / have title, <server> / run <line>` into the `iterm` tool (find/tool/iterm,
// driver find/driver/mac.js, JXA over `osascript`) types into the iTerm2 session with that title, and raises
// `find-none` or `find-many` having typed nothing. The program is deck/base/test/find/iterm.tree, run by the built CLI
// (`term test`). Held here, by reading each session's CONTENTS back from iTerm2:
//
//   1  the one session with the title received the exact text: the line and its output are in its contents
//   2  quotes, an apostrophe, a semicolon and a variable reach it as the same characters (never built into script
//      source: the driver passes the text as one string argument of `write`)
//   3  a title no session has raises find-none: nothing was typed anywhere
//   4  a title two sessions have raises find-many: nothing was typed in either
//   5  a session of another title was never typed into
//
// It touches ONLY what it makes: one new iTerm2 window, its four sessions titled `term-find-0008-<random>-...`, closed
// at the end. A session the person already has is never read, typed into or closed, and the program can only reach
// one that has a title this test made up. The commands typed are `echo`s.
//
// Consent is macOS Automation for iTerm2, for the process running this test. Without it, or without iTerm2, the test
// prints SKIP with what to allow, and exits 0: a skip is not a pass of anything.
//
//   sh tmp/dec-tsx.sh test/compile/find-native.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const ROOT = join(HERE, '../..')
const BASE = join(ROOT, 'deck/base')
const LINE = join(ROOT, 'host/line.js')
const TMP = join(ROOT, 'tmp')
const ITERM = '/Applications/iTerm.app'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1800)}`)
  }
}

function skip(why: string): never {
  console.log(`SKIP  find-native (mac): ${why}`)
  process.exit(0)
}

if (process.platform !== 'darwin') skip('this is not a Mac')
if (!existsSync(ITERM)) skip(`iTerm2 is not installed at ${ITERM}`)
if (!existsSync(LINE)) skip(`the CLI is not built (${LINE}): pnpm run make:line`)

// the one JXA helper, arguments by argv so no text of ours is ever spliced into script source
const HELPER = `
function sessionsOf(app, windowId) {
  var out = []
  var tabs = app.windows.byId(windowId).tabs()
  for (var t = 0; t < tabs.length; t++) {
    var all = tabs[t].sessions
    var ids = all.id()
    var names = all.name()
    for (var s = 0; s < ids.length; s++) out.push({ id: ids[s], name: names[s] })
  }
  return out
}

function run(argv) {
  var app = Application('iTerm2')
  var op = argv[0]
  if (op === 'create') {
    var titles = argv.slice(1)
    var window = null
    for (var at = 0; at < titles.length; at++) {
      var command = '/bin/sh -c "printf \\\\"\\\\\\\\033]0;' + titles[at] + '\\\\\\\\007\\\\"; exec /bin/sh"'
      if (window === null) window = app.createWindowWithDefaultProfile({ command: command })
      else window.createTabWithDefaultProfile({ command: command })
    }
    return JSON.stringify({ window: window.id() })
  }
  if (op === 'sessions') return JSON.stringify(sessionsOf(app, Number(argv[1])))
  if (op === 'count') return String(app.windows().length)
  if (op === 'contents') {
    var tabs = app.windows.byId(Number(argv[1])).tabs()
    for (var t = 0; t < tabs.length; t++) {
      var live = tabs[t].sessions()
      for (var s = 0; s < live.length; s++) if (live[s].id() === argv[2]) return live[s].text()
    }
    return ''
  }
  if (op === 'left') {
    try {
      var held = app.windows.byId(Number(argv[1])).tabs()
      var count = 0
      for (var u = 0; u < held.length; u++) count += (held[u].sessions() || []).length
      return String(count)
    } catch (gone) {
      return '0'
    }
  }
  if (op === 'exit') {
    // every session object first: closing one changes the tabs under the walk
    var every = []
    var left = app.windows.byId(Number(argv[1])).tabs()
    for (var q = 0; q < left.length; q++) {
      var live = left[q].sessions()
      for (var r = 0; r < live.length; r++) every.push(live[r])
    }
    for (var v = 0; v < every.length; v++) {
      try {
        every[v].write({ text: 'exit' })
      } catch (gone) {}
    }
    return 'exit'
  }
  if (op === 'close') {
    app.windows.byId(Number(argv[1])).close()
    return 'closed'
  }
  if (op === 'windows') return app.windows().map(function (w) { return w.id() }).join(',')
  return ''
}
`

mkdirSync(TMP, { recursive: true })
const helperPath = join(TMP, 'find-native-iterm.js')
writeFileSync(helperPath, HELPER)

type Sessions = { id: string; name: string }[]

function jxa(...args: string[]): string {
  return execFileSync('osascript', ['-l', 'JavaScript', helperPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  }).trim()
}

// consent: the cheapest Apple event to iTerm2
try {
  jxa('count')
} catch (cause) {
  const text = String((cause as { stderr?: string }).stderr ?? cause)

  if (text.includes('-1743') || text.includes('Not authorized')) {
    skip(
      'Automation for iTerm2 is not allowed. Open System Settings > Privacy & Security > Automation, and under the app ' +
        'that runs this test (Terminal, iTerm2 or Claude) switch on iTerm2. Then run it again.',
    )
  }

  skip(`iTerm2 did not answer: ${text.slice(0, 300)}`)
}

const mark = Math.random().toString(36).slice(2, 8)
const token = `term-find-0008-${mark}`
const titles = [`${token}-server`, `${token}-other`, `${token}-dup`, `${token}-dup`]
const before = jxa('windows')
let windowId = ''

try {
  windowId = (JSON.parse(jxa('create', ...titles)) as { window: number }).window.toString()

  // each session's title is what its shell printed (iTerm2 adds the job name); poll until all four are in
  let sessions: Sessions = []
  for (let tries = 0; tries < 60; tries++) {
    sessions = JSON.parse(jxa('sessions', windowId)) as Sessions

    if (sessions.length === 4 && sessions.every((one) => one.name.startsWith(token))) break
  }

  ok('the test window holds four sessions with the made-up titles', sessions.length === 4 && sessions.every((one) => one.name.startsWith(token)), JSON.stringify(sessions))

  const byName = (suffix: string): Sessions => sessions.filter((one) => one.name.startsWith(`${token}-${suffix}`))
  let server = byName('server')[0]
  let other = byName('other')[0]
  let dup = byName('dup')

  ok('one session each of server and other, two of dup', Boolean(server) && Boolean(other) && dup.length === 2, JSON.stringify(sessions))

  // the shells are up when their prompt is in the contents
  const contentsOf = (session: { id: string }): string => jxa('contents', windowId, session.id)

  for (const session of sessions) {
    for (let tries = 0; tries < 60; tries++) {
      if (contentsOf(session).includes('$')) break
    }
  }

  // the names once more, as late as possible: iTerm2 appends the running job to a title, and it changes when one does
  sessions = JSON.parse(jxa('sessions', windowId)) as Sessions
  server = byName('server')[0]
  other = byName('other')[0]
  dup = byName('dup')

  const env = {
    ...process.env,
    TERM_FIND_ITERM_SERVER: server.name,
    TERM_FIND_ITERM_OTHER: other.name,
    TERM_FIND_ITERM_DUP: dup[0].name,
    TERM_FIND_ITERM_ABSENT: `${token}-absent`,
  }

  const ran = spawnSync('node', [LINE, 'test', 'find/iterm'], {
    cwd: BASE,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 540000,
  })
  const exit = ran.status ?? 1
  const verdict = `${ran.stdout}${ran.stderr}`

  ok('the Term test of the program passes: 4 tests, 4 passed', exit === 0 && verdict.includes('4 tests') && verdict.includes('4 passed') && !verdict.includes('failed'), verdict)

  // what each session holds now: poll until the shell has printed the output of what was typed
  const wait = (session: { id: string }, needle: string): string => {
    let text = ''

    for (let tries = 0; tries < 60; tries++) {
      text = contentsOf(session)

      if (text.includes(needle)) break
    }

    return text
  }
  const serverText = wait(server, `\n${'term-find-0008-awk'} a'b`)
  const lines = serverText.split('\n').map((line) => line.trimEnd())

  ok('the server session shows the typed line and its output', lines.some((line) => line.endsWith('echo term-find-0008-ok')) && lines.includes('term-find-0008-ok'), serverText)
  ok(
    `the awkward line arrived exactly: echo term-find-0008-awk "a'b" ; echo $HOME`,
    lines.some((line) => line.endsWith(`echo term-find-0008-awk "a'b" ; echo $HOME`)),
    serverText,
  )
  ok("its output is the quoted text and the person's home", lines.includes("term-find-0008-awk a'b") && lines.includes(process.env.HOME ?? '/'), serverText)

  const quiet = [other, ...dup].map((one) => ({ name: one.name, text: contentsOf(one) }))

  ok('none of the other sessions was typed into', quiet.every((one) => !one.text.includes('term-find-0008-ok') && !one.text.includes('term-find-0008-awk') && !one.text.includes('echo ')), JSON.stringify(quiet))
  const everything = [serverText, ...quiet.map((one) => one.text)].join('\n')

  ok('find-none and find-many typed nothing anywhere', !everything.includes('term-find-0008-none') && !everything.includes('term-find-0008-many'), everything)
} finally {
  if (windowId) {
    // the shells are asked to exit, which closes the tabs and then the window without a confirmation (a `close` of a
    // window with live shells can sit on a prompt)
    try {
      jxa('exit', windowId)
    } catch {
      // already gone
    }
  }
}

// iTerm2 closes a window a moment after being told to: ask again until it is gone
// the windows other than ours are as they were. Ours is closed when it is gone or holds no session: under load iTerm2
// can leave the empty shell of a closed window listed for a long time
const sorted = (list: string): string => list.split(',').sort().join(',')
const others = (list: string): string => sorted(list.split(',').filter((id) => id !== windowId).join(','))
let left = jxa('left', windowId)

for (let tries = 0; tries < 30 && left !== '0'; tries++) {
  // iTerm2 sometimes drops the first `exit`: ask again of what is left
  try {
    jxa('exit', windowId)
  } catch {
    // the window went while asking
  }

  left = jxa('left', windowId)
}

const after = others(jxa('windows'))

// cleanup is reported, never counted: on a loaded Mac iTerm2 leaves the empty shell of an exited window listed, and
// that is iTerm2's, not the find construct's. The sessions this test made are what it checks it ended
console.log(
  left === '0' && after === others(before)
    ? 'ok    the window this test opened holds no session, and the others are as they were'
    : `WARN  cleanup: ${left} sessions of the test window are left, windows ${before} -> ${after}; exit them by hand`,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
