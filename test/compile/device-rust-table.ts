// The device modules on Linux and Windows (term-device-layer-0001): every module either has a Rust host, or answers
// `unavailable` from its fallback, and the guide's table (note/project/term/guides/draft/applications/device.md, "On
// Linux and Windows") says which, one row a module.
//
// Two halves. The TABLE: every device module the cask carries has a row; a row reads `unavailable` on all three
// platforms exactly when site/code/view/native/rust/<module>.tree does not exist; and every tool a hosted row names in
// backticks is one its runtime (runtime/native-<module>.rs) calls. The RUN: one Rust program calls every module once on
// this machine, and each module with no Rust host answers `unavailable`, while each with one answers from the platform:
// the notification and the file picker reach `osascript` (on Linux `notify-send` and `zenity`), which a stand-in on the
// PATH answers, so no banner or dialog ever comes up on the screen of whoever is at the machine. The stand-in records
// what it was asked, and that record is the witness: the title and the body, the dialog's kind, and the picked file's
// copy holding the fixture's bytes.
//
// The person's clipboard is kept and put back. Skips without rustc. Run: npx tsx test/compile/device-rust-table.ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOn } from './shared/run-on'
import { DEVICE_MODULES } from '@term/call/code/cask-generate'
import { projectResolver } from '@term/call/code/make'

const ROOT = join(import.meta.dirname, '..', '..')
const VIEW = join(ROOT, 'deck/site/code/view')
const GUIDE = join(ROOT, '../../../../note/project/term/guides/draft/applications/device.md')

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

const hosted = (module: string): boolean => existsSync(join(VIEW, 'native/rust', `${module}.tree`))

// ---- the table ----

// the rows of the guide's "On Linux and Windows" table: module, then the Linux, Windows and macOS cells
function tableRows(): Map<string, string[]> {
  const text = readFileSync(GUIDE, 'utf8')
  const section = text.slice(text.indexOf('## On Linux and Windows'), text.indexOf('\n## ', text.indexOf('## On Linux and Windows') + 3))
  const rows = new Map<string, string[]>()

  for (const line of section.split('\n')) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    const name = /^`([a-z-]+)`$/.exec(cells[0] ?? '')?.[1]

    if (name && cells.length === 4) {
      rows.set(name, cells.slice(1))
    }
  }

  return rows
}

// the public tasks a contract declares, so a row may name them without the runtime calling them
function tasksOf(module: string): string[] {
  return [...readFileSync(join(VIEW, `${module}.tree`), 'utf8').matchAll(/^task ([a-z-]+)$/gm)].map(match => match[1]!)
}

const rows = tableRows()
const modules = [...DEVICE_MODULES].sort()

ok('the guide has a row for every device module', modules.every(one => rows.has(one)), modules.filter(one => !rows.has(one)).join(', '))
ok('and a row for nothing else', [...rows.keys()].every(one => modules.includes(one)), [...rows.keys()].filter(one => !modules.includes(one)).join(', '))

for (const module of modules) {
  const cells = rows.get(module)

  if (!cells) {
    continue
  }

  if (!hosted(module)) {
    ok(`${module}: no Rust host, and the row says unavailable on all three`, cells.every(cell => cell === '`unavailable`'), cells.join(' | '))
    continue
  }

  const runtime = readFileSync(join(VIEW, 'native/rust/runtime', `native-${module}.rs`), 'utf8')
  const own = new Set(['unavailable', ...tasksOf(module)])
  const named = cells.flatMap(cell => [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]!)).filter(one => !own.has(one))
  const missing = named.filter(tool => !tool.split(/\s+/).every(word => runtime.includes(word)))

  ok(`${module}: a Rust host, and no cell says unavailable`, cells.every(cell => cell !== '`unavailable`'), cells.join(' | '))
  ok(`${module}: every tool its row names is in native-${module}.rs`, missing.length === 0, missing.join(', '))
}

// ---- the run ----

// one call a module, answering text, each harmless where it is answered: nothing is written but the clipboard (kept
// and put back), and the calls that would reach a person (a banner, a dialog) reach the stand-in
const CALLS: Record<string, { finds: string[]; call: string[] }> = {
  permission: { finds: ['permission-status'], call: ['call permission-status', '  text <camera>'] },
  camera: { finds: ['take-photo'], call: ['call take-photo'] },
  microphone: { finds: ['record-audio'], call: ['call record-audio', '  code 1'] },
  // the length of a sound: its fallback answers unavailable, where the loop's state is `stopped` on every host
  audio: { finds: ['audio-length'], call: ['call audio-length', '  text <{work}/none.wav>'] },
  download: { finds: ['download-file'], call: ['call download-file', '  text <https://example.invalid/term>', '  text <{work}/download>'] },
  files: { finds: ['pick-file'], call: ['call pick-file', '  text <json>'] },
  contacts: { finds: ['find-contacts'], call: ['call find-contacts', '  text <term>'] },
  calendar: { finds: ['find-events'], call: ['call find-events', '  text <2031-01-01T00:00:00Z>', '  text <2031-01-02T00:00:00Z>'] },
  photos: { finds: ['find-photos'], call: ['call find-photos', '  code 1'] },
  torch: { finds: ['torch-state'], call: ['call torch-state'] },
  location: { finds: ['current-position'], call: ['call current-position'] },
  clipboard: { finds: ['write-clipboard'], call: ['call write-clipboard', `  text <term-rust-table-${process.pid}>`] },
  vibration: { finds: ['vibrate'], call: ['call vibrate', '  text <light>'] },
  notification: { finds: ['show-notification'], call: ['call show-notification', '  text <Term table>', '  text <Every module once>'] },
  open: { finds: ['open-address'], call: ['call open-address', '  text <term-no-handler://nothing>'] },
  battery: { finds: ['battery-status'], call: ['call battery-status'] },
  network: { finds: ['network-status'], call: ['call network-status'] },
  motion: { finds: ['read-motion'], call: ['call read-motion'] },
  secret: { finds: ['save-secret'], call: ['call save-secret', '  text <term-rust-table>', '  text <kept>'] },
  biometric: { finds: ['biometric-kind'], call: ['call biometric-kind'] },
}

ok('the run calls every device module', modules.every(one => CALLS[one]), modules.filter(one => !CALLS[one]).join(', '))

const work = mkdtempSync(join(tmpdir(), 'device-rust-table-'))
const shims = join(work, 'shims')
const record = join(work, 'asked.txt')
const fixture = join(work, 'chosen.json')
const fixtureText = `{"picked": ${process.pid}}\n`

mkdirSync(shims)
writeFileSync(fixture, fixtureText)

// the stand-in for every tool that would put something in front of a person: it writes each argument on a line of its
// own, then a line `--`, and answers a file dialog with the fixture's path
const SHIM = [
  '#!/bin/sh',
  'for argument in "$@"; do printf \'%s\\n\' "$argument" >> "$TERM_TABLE_ASKED"; done',
  'printf -- \'--\\n\' >> "$TERM_TABLE_ASKED"',
  'case "$*" in *"choose file"*|*--file-selection*|*--getopenfilename*) printf \'%s\\n\' "$TERM_TABLE_PICK" ;; esac',
  'exit 0',
  '',
].join('\n')

for (const tool of ['osascript', 'notify-send', 'zenity', 'kdialog']) {
  writeFileSync(join(shims, tool), SHIM)
  chmodSync(join(shims, tool), 0o755)
}

const path = `${shims}:${process.env.PATH ?? ''}`
const reached = spawnSync('sh', ['-c', 'command -v osascript notify-send zenity'], { encoding: 'utf8', env: { ...process.env, PATH: path } }).stdout

// the guard: the stand-in must be what the program finds, or a real banner could come up
if (!reached.split('\n').filter(Boolean).every(found => found.startsWith(shims))) {
  ok('the stand-ins are first on the path', false, reached)
  console.log(`\ndevice-rust-table: ${pass} pass, ${fail} fail`)
  process.exit(1)
}

const program = [
  ...modules.flatMap(module => [`load @term/site/view/${module}`, ...CALLS[module]!.finds.map(find => `  find ${find}`), '']),
  'load @term/base/list',
  '  find push',
  '',
  'load @term/base/text/util',
  '  find join',
  '',
  'task run',
  '  like text',
  `  save work, text <${work}>`,
  '  save answers',
  '    make list',
  ...modules.flatMap(module => [
    `  save answer-${module}`,
    ...CALLS[module]!.call.map(line => `    ${line}`),
    '  call push',
    '    bind list, read answers',
    `    bind item, read answer-${module}`,
  ]),
  '  send back',
  '    call join',
  '      read answers',
  '      text <|>',
  '',
].join('\n')

const kept = process.platform === 'darwin' ? spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout : undefined
const before = { PATH: process.env.PATH }

try {
  process.env.PATH = path
  process.env.TERM_TABLE_ASKED = record
  process.env.TERM_TABLE_PICK = fixture

  const ran = runOn({ backend: 'rust', program, resolve: env => projectResolver(ROOT, env, ROOT), dir: work, name: 'table' })

  if (ran.form === 'skipped') {
    console.log(`skip  device-rust-table run  (${ran.reason})`)
  } else {
    ok('the program calling every module builds and runs on Rust', ran.form === 'ran', ran.form === 'ran' ? '' : `${ran.stage}: ${ran.reason.slice(0, 1600)}`)

    if (ran.form === 'ran') {
      const answers = new Map(modules.map((module, index) => [module, ran.output.trim().split('|')[index] ?? '']))
      console.log(`      ${[...answers].map(([module, answer]) => `${module} ${answer}`).join(', ')}`)

      for (const module of modules.filter(one => !hosted(one))) {
        ok(`${module}: no Rust host, answers unavailable`, answers.get(module) === 'unavailable', answers.get(module))
      }

      const asked = existsSync(record) ? readFileSync(record, 'utf8') : ''
      const calls = asked.split('--\n').filter(Boolean)

      ok('clipboard: written', answers.get('clipboard') === 'written', answers.get('clipboard'))
      ok('battery: in the closed set', /^(\d\.\d\d (charging|full|unplugged|unknown)|unavailable)$/.test(answers.get('battery') ?? ''), answers.get('battery'))
      ok('network: online', /^online /.test(answers.get('network') ?? ''), answers.get('network'))
      ok('open: an address nothing handles is unavailable', answers.get('open') === 'unavailable', answers.get('open'))
      ok('notification: shown', answers.get('notification') === 'shown', answers.get('notification'))
      ok(
        'and the platform tool was asked with the title and the body',
        calls.some(call => call.includes('Term table\n') && call.includes('Every module once\n') && /display notification|^Term table$/m.test(call)),
        asked.slice(0, 400),
      )

      const picked = /^file (.+)$/.exec(answers.get('files') ?? '')?.[1]
      ok('files: the choice answered as a copy', picked !== undefined && picked !== fixture && picked.endsWith('/chosen.json'), answers.get('files'))
      ok('and the copy holds the chosen file', picked !== undefined && existsSync(picked) && readFileSync(picked, 'utf8') === fixtureText)
      ok('and the dialog was asked for json', calls.some(call => /public\.json|\*\.json/.test(call)), asked.slice(0, 400))
    }
  }
} finally {
  process.env.PATH = before.PATH
  delete process.env.TERM_TABLE_ASKED
  delete process.env.TERM_TABLE_PICK

  if (kept !== undefined) {
    execFileSync('pbcopy', [], { input: kept })
  }
}

console.log(`\ndevice-rust-table: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
