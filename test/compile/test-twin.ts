// A TEST TWIN (term/decisions-2026-10/mocks 0001, spec 2.1 and 3.1): a `twin` declared in a file under its package's
// `test/` is admitted by its signature alone, so it can stand in for an IMPURE task, and compile()'s `twins` choice
// makes every call to that task in the build reach it.
//
// The fixture is two files in a temporary package folder. `code/app.tree` holds `read-config` (reads a file that does
// not exist) and `describe` (calls it). `test/app.tree`, the entry, loads `describe` and `read-config` and declares the
// twin `fake`, which answers a fixed text. Chosen, the run prints the twin's text: the call from `describe`, in another
// file, reached the twin. The SAME twin written under `code/` is refused `twin-of-impure`, and `count.tree`'s two twins
// are still admitted. Run: npx tsx test/compile/test-twin.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { projectResolver } from '../../deck/call/code/make'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const stdlib = stdlibResolver()!
const dir = mkdtempSync(join(tmpdir(), 'test-twin-'))
mkdirSync(join(dir, 'code'))
mkdirSync(join(dir, 'test'))

const APP = `load @term/base/file
  find read

task read-config
  mark async
  take path, like text
  like text
  send back
    call read
      read path

task describe
  mark async
  like text
  save body
    call read-config
      text </nonexistent/config.txt>
  send back, text <config={body}>
`

const FAKE = `twin read-config, name fake
  take path
  send back, text <fake text>
`

const ANSWER = `task answer
  mark async
  like text
  send back
    call describe
`

writeFileSync(join(dir, 'code/app.tree'), APP)
writeFileSync(join(dir, 'deck.tree'), 'deck @fixture/mocks\n  head <A package for the test twin check>\n  mark <0.0.0>\n')
const resolve = projectResolver(dir, 'node')

const IMPORTS = `load ../code/app
  find describe
  find read-config

`

// the entry under test/: loads the code, declares the twin, and has a task the run calls
const testEntry = (extra: string): { file: string; text: string } => {
  const file = join(dir, 'test/app.tree')
  const text = `${IMPORTS}${extra}\n${ANSWER}`
  writeFileSync(file, text)

  return { file, text }
}

const messages = (diagnostics: Diagnostic[]): string => diagnostics.map(d => d.message).join(' | ')

function build(source: { file: string; text: string }, options: Record<string, unknown> = {}) {
  return compile(source, { resolve, env: 'node', ...options })
}

// 1. the test twin is admitted, and chosen, every call reaches it
const mocked = build(testEntry(FAKE), { twins: { 'read-config': { use: 'fake' } } })

ok('a test twin of an impure task builds', mocked.ok, mocked.ok ? '' : messages(mocked.diagnostics))

if (mocked.ok) {
  ok('the call from describe goes through the dispatch', /readConfigChosen\(/.test(mocked.typescript), mocked.typescript.slice(0, 300))

  const file = join(dir, 'run.ts')
  writeFileSync(file, `${mocked.typescript}\nanswer().then(value => process.stdout.write(String(value)))\n`)

  try {
    const out = execFileSync('npx', ['tsx', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    ok('the twin text came back from the code under test', out.trim() === 'config=fake text', `got ${out.trim()}`)
  } catch (error) {
    ok('the twin text came back from the code under test', false, String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 600))
  }
}

// 2. admitted with no choice too (admission is the signature, not the selection)
const unchosen = build(testEntry(FAKE))
ok('a test twin is admitted without a choice', unchosen.ok, unchosen.ok ? '' : messages(unchosen.diagnostics))
ok('an unchosen test twin leaves the reference in place', unchosen.ok && !/readConfigChosen|readConfigTwinFake/.test(unchosen.typescript))

// 3. an impure test twin (its own file read) is admitted as well
const IMPURE_FAKE = `load @term/base/file
  find read

twin read-config, name from-disk
  take path
  send back
    call read
      read path
`
const impure = build(testEntry(IMPURE_FAKE))
ok('an impure test twin is admitted', impure.ok, impure.ok ? '' : messages(impure.diagnostics))

// 4. a test twin keeps the refusals that say it could not stand in at all
const unknown = build(testEntry(FAKE.replace('read-config,', 'read-nothing,')))
ok('a test twin of no task is refused', !unknown.ok && /there is no task/.test(messages(unknown.diagnostics)), unknown.ok ? 'built' : messages(unknown.diagnostics))

const wrong = build(testEntry(FAKE.replace('take path\n', 'take path\n  take extra\n')))
ok('a test twin with another signature is refused', !wrong.ok && /takes/.test(messages(wrong.diagnostics)), wrong.ok ? 'built' : messages(wrong.diagnostics))

// 5. the same twin under code/ is refused twin-of-impure
const inCode = join(dir, 'code/main.tree')
const refused = build({ file: inCode, text: `${APP}\n${FAKE}\n${ANSWER}` })
ok('the same twin under code/ is refused as a twin of an impure task', !refused.ok && /is not pure/.test(messages(refused.diagnostics)), refused.ok ? 'built' : messages(refused.diagnostics))

// 6. test twins are not exposed to the differential admission, and a non-test twin still is
const exposed = build(testEntry(FAKE), { exposeTwins: true })
ok('a test twin is not exposed for the differential admission', exposed.ok && !/readConfigTwinFake/.test(exposed.typescript), exposed.ok ? '' : messages(exposed.diagnostics))

// 7. count.tree's twins are still admitted and exposed
const countFile = stdlib('@term/base/count', 'x.tree')
const count = countFile ? build(countFile, { exposeTwins: true }) : undefined
ok('count.tree twins are still admitted', !!count?.ok && (count.twins?.length ?? 0) === 2, count?.ok ? `${count.twins?.length} twins` : count ? messages(count.diagnostics) : 'count.tree not found')
ok('count.tree twins are still exposed', !!count?.ok && /countEachTwinTally/.test(count.typescript))

console.log(`\ntest-twin: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
