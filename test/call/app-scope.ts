// An app's scope at BUILD time (app-scope, deck/call/code/scope.ts): its scope.tree read as data, every way of writing
// it wrong refused with a message naming the line's mistake, and a program that reaches a capability its scope does not
// name refused before anything is built, through the same check `term make` and `term work` run on a Compose app. The
// RUN time half, the cask's gate, is held by test/compile/cask-scope.ts (the matcher on four backends) and cask/smoke
// (a page's read outside its scope refused in a real WebView).
// Run: npx tsx test/call/app-scope.ts

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCompose } from '@term/call/code/compose'
import { projectResolver } from '@term/call/code/make'
import { checkScope, readScope } from '@term/call/code/scope'
import { collectModules } from '@term/make/code/compile/load'

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

// the app folders are under this package's tmp/ (gitignored), so their `@term/*` loads resolve as any app's would
const ROOT = join(import.meta.dirname, '../..')
const BASE = join(ROOT, 'tmp', 'app-scope')
rmSync(BASE, { recursive: true, force: true })

function app(name: string, files: Record<string, string>): string {
  const dir = join(BASE, name)
  mkdirSync(dir, { recursive: true })

  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(dir, file), text)
  }

  return dir
}

// what a call threw, or empty text
function thrown(run: () => unknown): string {
  try {
    run()
  } catch (e) {
    return (e as Error).message
  }

  return ''
}

// ---- reading a scope ----

const good = readScope(app('good', { 'scope.tree': 'host file\n  list read, <$data/**>, <$home/notes/**>\n  list write, <$data/**>\nhost environment\n  list read, <HOME>\nhost db\n' })).scope
ok('a scope reads its capabilities in order', [...good.keys()].join(' ') === 'file environment db', [...good.keys()].join(' '))
ok("each access its patterns, in order", JSON.stringify(good.get('file')) === JSON.stringify({ read: ['$data/**', '$home/notes/**'], write: ['$data/**'] }), JSON.stringify(good.get('file')))
ok('a capability with no lists is named with none', JSON.stringify(good.get('db')) === '{}', JSON.stringify(good.get('db')))
ok('an app with no scope.tree has an empty scope, which denies everything', readScope(app('none', {})).scope.size === 0)

const refusals: [what: string, scope: string, says: string][] = [
  ['a capability that does not exist', 'host files\n  list read, <$data/**>\n', 'not a capability'],
  ['an access the capability does not have', 'host environment\n  list run, <x>\n', 'has no `run` list'],
  ['an access list on an all-or-nothing capability', 'host db\n  list read, <x>\n', 'all or nothing'],
  ['a pattern with an angle in it', 'host file\n  list read, <a\\>b>\n', 'holds no'],
  ['a pattern with a brace in it', 'host file\n  list read, <a\\{b\\}>\n', 'holds no'],
  ['an empty pattern', 'host file\n  list read, <>\n', 'an empty pattern'],
  ['a list where a capability belongs', 'list file, <x>\n', 'with its access lists beneath'],
  ['a file that is code, not data', 'task file\n  take x, like text\n', 'not a data file'],
]

for (const [what, scope, says] of refusals) {
  const message = thrown(() => readScope(app(`bad-${what.replace(/\W+/g, '-')}`, { 'scope.tree': scope })))
  ok(`refused: ${what}`, message.includes(says), message || 'not refused')
}

// ---- a program against its scope ----

// a program that reads a file, and so reaches the `file` capability
const READS = `load @term/base/file
  find read

task main
  save text
    call read
      text </tmp/x>
`

// a program that reaches nothing outside its process
const PURE = `task main
  save x, code 1
`

// the files a program's build loads, which is what the check is handed
const files = (dir: string, text: string): string[] => {
  writeFileSync(join(dir, 'app.tree'), text)

  return collectModules({ file: join(dir, 'app.tree'), text }, projectResolver(dir, 'compose')).sources.map(one => one.file)
}

const bare = app('reads-bare', {})
const refusedBare = thrown(() => checkScope({ root: bare, files: files(bare, READS) }))
ok('a program that reaches `file` with no scope.tree is refused', refusedBare.includes('`file`') && refusedBare.includes('it has no scope.tree'), refusedBare)
ok('the refusal names the module it reached it through, and the line that would grant it', /deck\/base\/code\/file/.test(refusedBare) && refusedBare.includes('add host file'), refusedBare)

const other = app('reads-other', { 'scope.tree': 'host db\n' })
const refusedOther = thrown(() => checkScope({ root: other, files: files(other, READS) }))
ok('naming other capabilities does not grant this one', refusedOther.includes('its scope.tree does not name it'), refusedOther)

const granted = app('reads-granted', { 'scope.tree': 'host file\n  list read, <$data/**>\n' })
ok('a scope that names `file` lets it build', thrown(() => checkScope({ root: granted, files: files(granted, READS) })) === '')

const pure = app('pure', {})
ok('a program that reaches nothing needs no scope at all', thrown(() => checkScope({ root: pure, files: files(pure, PURE) })) === '')

// ---- through the Compose build, as `term make` and `term work` run it ----

// the stage is the proof that nothing was compiled: `scope` comes after the Term compile and before the Kotlin one
const composed = app('compose', { 'app.tree': READS })
const built = buildCompose({ root: composed, dir: composed, name: 'app', text: READS, file: join(composed, 'app.tree'), scope: { root: composed } })
ok(
  'the Compose build refuses it at its `scope` stage, before any Kotlin is compiled',
  built.form === 'failed' && built.stage === 'scope' && built.reason.includes('`file`'),
  JSON.stringify(built).slice(0, 400),
)

console.log(`\napp-scope: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
