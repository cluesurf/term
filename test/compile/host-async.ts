// A `dock load` line may say `mark async`: every function of that module returns a promise, so a call into it is
// awaited with no `wait` written, and makes its caller async, the same as a call to an async task. Until 2026-10-05
// the build could not be told, so every such call needed its own `wait`, and one left without it handed the promise
// on (`deck.tree holds undefined characters`). A local of the module's name shadows it, `tick` still starts the call
// without waiting, and any other word under the line is refused. L054 reports a `wait true` it makes redundant.
// Run: npx tsx test/compile/host-async.ts

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOn } from './shared/run-on'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { analyze } from '@term/make/code/analyze'

const ROOT = join(import.meta.dirname, '..', '..')

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

const run = (program: string): { output: string; emitted: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'host-async-'))
  const ran = runOn({ backend: 'typescript', program, resolve: env => projectResolver(ROOT, env, ROOT), dir, name: 'host' })
  const output = ran.form === 'ran' ? ran.output : `${ran.form}: ${ran.reason.slice(0, 400)}`
  let emitted = ''

  try {
    emitted = readFileSync(join(dir, 'host-typescript.ts'), 'utf8')
  } catch {}

  return { output, emitted }
}

const docked = `dock load
  load <node:fs/promises>, name fs-promise
    mark async

task read-length
  take path, like text
  like number
  save body, fs-promise/read-file(path, <utf8>)
  back body/length

task run
  like text
  save size, read-length(<deck.tree>)
  back <{size}>
`
const awaited = run(docked)
ok('a call into an async dock is awaited with no wait written', /^\d+$/.test(awaited.output) && awaited.output !== '0', awaited.output)
ok('the call is written awaited', awaited.emitted.includes('await fsPromise.readFile(path, "utf8")'), awaited.emitted.slice(0, 600))
ok('its caller becomes async, and the caller of that', /async function readLength/.test(awaited.emitted) && /async function run/.test(awaited.emitted), awaited.emitted.slice(0, 600))

const plain = run(docked.replace('\n    mark async', ''))
ok('without the mark the promise is handed on, as before', plain.output === 'undefined', plain.output)

const ticked = run(`dock load
  load <node:fs/promises>, name fs-promise
    mark async

task run
  like text
  tick fs-promise/read-file(<deck.tree>, <utf8>)
  back <started>
`)
ok('tick starts a call into an async dock without waiting', ticked.output === 'started' && !ticked.emitted.includes('await fsPromise'), `${ticked.output} ${ticked.emitted.slice(0, 400)}`)

const other = compile({
  file: join(ROOT, 'tmp/host-async.tree'),
  text: `dock load
  load <node:path>, name path
    mark stable

task run
  like text
  back path/join(<a>, <b>)
`,
}, { resolve: projectResolver(ROOT, 'node', ROOT) })
const refused = other.ok ? 'BUILT' : other.diagnostics.map(d => d.message).join(' | ')
ok('another word under a load line is refused', /`mark stable` under a `dock load` line is read by nothing/.test(refused), refused)

const lint = analyze({
  file: 'w.tree',
  text: `dock load
  load <node:fs/promises>, name fs-promise
    mark async

task run
  like text
  save body
    call fs-promise/read-file
      text <deck.tree>
      text <utf8>
      wait true
  back body
`,
}).lint()
const redundant = lint.filter(f => f.code === 'L054').map(f => f.message).join(' | ')
ok('L054 reports a wait true the mark makes redundant', /"fs-promise" is docked `mark async`/.test(redundant), redundant || JSON.stringify(lint.map(f => f.code)))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
