// A raise's `flow` holds TERM frames, the same bytes on TypeScript, Rust, Swift and Kotlin (term/hive decision 001,
// note/project/term/hive/decision/001-raise-records-term-frames.md): `<task> <file>:<line>`, the raise site first, then
// each call the exception leaves through, up to the call in the guarded block that catches it, at most 64.
//
// raise-flow-native/flow.tree prints, by `inspect`, the flow of: a form raise three tasks below the guard (two of the
// tasks inlined by the simplifier, which keep their frames), a `halt <text>`, a raise in a handler, a raise caught inside
// a closure (named by the task it is written in), a recursion 100 deep (64 frames), and a call to a task that cannot
// raise beside one that can (no frame for it). Its standard output is flow.golden on every backend. uncaught.tree raises
// with nothing to catch it: every backend prints the form, the note and the frames to standard error, uncaught.golden,
// and exits 1. Each program is written to one path on every backend, `<dir>/<backend>/<name>.tree`, since a frame
// names its file.
// Run: npx tsx test/compile/raise-flow-native.ts   (FLOW_ONLY=typescript, rust, swift or kotlin runs one)

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, buildOn } from './shared/run-on'

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

// the first line where the two disagree
function diff(got: string, want: string): string {
  const a = got.split('\n')
  const b = want.split('\n')

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}: got ${JSON.stringify(a[i]?.slice(0, 300))}, want ${JSON.stringify(b[i]?.slice(0, 300))}`
    }
  }

  return ''
}

const HERE = join(dirname(fileURLToPath(import.meta.url)), 'raise-flow-native')
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'term-raise-flow-'))
const only = process.env.FLOW_ONLY ?? ''
const outs = new Map<string, string>()
const errs = new Map<string, string>()

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const own = join(dir, backend)
  mkdirSync(own, { recursive: true })
  const resolve = (env: Parameters<typeof projectResolver>[1]) => projectResolver(process.cwd(), env)
  const flow = buildOn({ backend, program: read('flow.tree'), resolve, dir: own, name: 'flow', file: join(own, 'flow.tree') })

  if (flow.form === 'skipped') {
    console.log(`skip  ${backend}: ${flow.reason}`)
    continue
  }

  if (flow.form === 'failed') {
    ok(`${backend}: the flow program builds`, false, `${flow.stage}: ${flow.reason}`)
  } else {
    const ran = spawnSync(flow.command[0]!, flow.command.slice(1), { encoding: 'utf8' })
    const out = String(ran.stdout)
    outs.set(backend, out)
    ok(`${backend}: every caught raise prints the Term frames the golden holds`, ran.status === 0 && out === read('flow.golden'), ran.status === 0 ? diff(out, read('flow.golden')) : String(ran.stderr).slice(0, 600))
  }

  const uncaught = buildOn({ backend, program: read('uncaught.tree'), resolve, dir: own, name: 'uncaught', file: join(own, 'uncaught.tree') })

  if (uncaught.form !== 'built') {
    ok(`${backend}: the uncaught program builds`, false, uncaught.form === 'failed' ? `${uncaught.stage}: ${uncaught.reason}` : uncaught.reason)
    continue
  }

  const ended = spawnSync(uncaught.command[0]!, uncaught.command.slice(1), { encoding: 'utf8' })
  const err = String(ended.stderr)
  errs.set(backend, err)
  ok(`${backend}: an uncaught raise exits 1`, ended.status === 1, `exit ${ended.status}`)
  ok(`${backend}: an uncaught raise prints its form, note and frames as the golden holds`, err === read('uncaught.golden'), diff(err, read('uncaught.golden')))
}

const same = (seen: Map<string, string>): boolean => [...seen.values()].every(one => one === [...seen.values()][0])
ok('the caught flows are the same bytes on every backend run', outs.size > 0 && same(outs), [...outs.keys()].join(', '))
ok('the uncaught report is the same bytes on every backend run', errs.size > 0 && same(errs), [...errs.keys()].join(', '))

console.log(`\nraise-flow-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
