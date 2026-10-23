// `@term/base/task` in a page (term-stdlib-parity-0006, gap 230 of the guides). The program is compiled for the
// `browser` env, so `native/{platform}/job` is native/browser/job.tree and its runtime runtime/job.ts, which uses no
// `node:` module, and it runs under Node with nothing of node's reached: the prelude is the browser's. Held: two jobs
// interleave at their waits and finish in the order their waits end, a gather answers in source order, and a
// cancelled job's wait raises `outage` as on every other backend. A module with no browser native (network/server,
// file/directory) is refused at the load, naming the module and the env, rather than as an unknown name further on.
// Run: npx tsx test/compile/browser-task.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'

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

const ROOT = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-browser-task-'))

const HEAD = `load @term/base/task
  find spawn
  find gather
  find handle

load @term/base/clock
  find delay

load @term/base/list
  find list

load @term/base/exception
  find outage
`

const RUN = `${HEAD}
task order
  mark async
  like text
  save done, make list
  save works, make list
  call works/push
    task a
      mark async
      like text
      call delay(60)
      call done/push(<a>)
      back <a>
  call works/push
    task b
      mark async
      like text
      call delay(10)
      call done/push(<b>)
      back <b>
  save results, gather(works)
  back <{done/0}{done/1} {results/0}{results/1}>

task cancelled
  mark async
  like text
  save job
    call spawn
      task work
        mark async
        like text
        call delay(200)
        back <late>
  call job/cancel()
  save answer, <none>
  fork
    mark unsafe
    save answer
      call wait
        read job
        wait true
  halt take
    take problem
    save answer, problem/form
  back answer

task run
  mark async
  like text
  save one, order()
  save two, cancelled()
  back <{one} {two}>
`

function build(program: string, name: string): { ok: true; file: string } | { ok: false; reason: string } {
  const file = join(dir, `${name}.tree`)
  writeFileSync(file, program)
  const result = compile({ file, text: program }, { resolve: projectResolver(ROOT, 'browser'), env: 'browser' } as never)

  if (!result.ok) {
    return { ok: false, reason: [...new Set(result.diagnostics.map(d => d.message))].slice(0, 4).join(' | ') }
  }

  const prelude = nativePrelude(result.program, 'browser', p => (existsSync(p) ? readFileSync(p, 'utf8') : undefined), result.typescript)
  const out = join(dir, `${name}.ts`)
  writeFileSync(out, `${prelude}\n${result.typescript}\nPromise.resolve(run()).then(text => process.stdout.write(String(text)))\n`)

  return { ok: true, file: out }
}

const built = build(RUN, 'task')

if (!built.ok) {
  ok('task builds for the browser', false, built.reason)
} else {
  const text = readFileSync(built.file, 'utf8')
  ok('the browser build reaches no node module', !/from ['"]node:|new AsyncLocalStorage/.test(text))
  const ran = spawnSync(process.execPath, ['--import', 'tsx', built.file], { encoding: 'utf8' })
  ok(
    'jobs interleave, a gather answers in order, and a cancelled job raises outage',
    ran.status === 0 && ran.stdout === 'ba ab outage',
    `exit ${ran.status}: ${JSON.stringify(ran.stdout)} ${ran.stderr.slice(0, 600)}`,
  )
}

for (const [module, find] of [
  ['@term/base/network/server', 'serve'],
  ['@term/base/file/directory', 'exists'],
]) {
  const refused = build(`load ${module}\n  find ${find}\n\ntask run\n  like text\n  back <x>\n`, module.split('/').pop()!)
  ok(
    `${module} is refused for the browser at its load, by name`,
    !refused.ok && refused.reason.includes(module.replace('@term/base/', '')) && refused.reason.includes('browser'),
    refused.ok ? 'it built' : refused.reason,
  )
}

console.log(`\nbrowser-task: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
