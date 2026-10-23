// A call through a LOCAL is never the global task of the same name (term-decisions-2026-10-seam-0029, the diagnosis in
// seam-0026). site's view/reactive.tree walks a scope's cleanups as `take site, name run` / `call run`, and the raise
// sets (check/effects.ts and effects.tree) and Rust's `?` (compile/rust-emit.tree) read the callee by its bare name,
// shadowing only parameters: once a test program's entry task `run` raised, the walk local took its raises, so
// `dispose_scope` turned fallible and Rust wrote `run()?` on an `Rc<dyn Fn()>`, which rustc refuses. Every name a body
// binds (a let, a walk's item, a closure's parameter, an arm's link, a caught name) now shadows a task of its name in
// all three, from one set (`boundNames`, `bound-names`, `bound-names-into`).
//
// Here: a raising top-level task `run`, and `fire`, which walks a list of closures as `take site, name run` and calls
// each. `fire`'s raise set must be empty in both twins, its Rust signature infallible with no `run()?`, and the program
// must build and run on every backend.
// Run: npx tsx test/compile/shadowed-callee.ts   (SC_ONLY=typescript, rust, swift or kotlin runs one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { raiseSetsOf } from '@term/make/code/check/effects'
import { raiseSetsOf as raiseSetsOfTree } from '@term/make/host/port/code/check/effects'
import { BACKENDS, runOn } from './shared/run-on'

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

const PROGRAM = `load @term/base/exception
  find absence

load @term/base/list
  find push

form outage
  like absence
    bind note, <down>

form tally
  mark shared
  link count, like number
  link cleanups
    like list
      like task

task add-cleanup
  take t, like tally
  take work
    like task
  call push
    bind list, read t/cleanups
    bind item, read work

# every cleanup, each called through a walk local named like the raising task below
task fire
  take t, like tally
  walk list, read t/cleanups
    hook next
      take site, name run
      call run

# the entry, which raises: a call to it raises \`outage\`, a call through \`fire\`'s local does not
task run
  like text
  save t
    make tally
      bind count, 0
      bind cleanups
        make list
  call add-cleanup
    read t
    task bump
      save t/count
        call add
          read t/count
          code 1
  call add-cleanup
    read t
    task bump-twice
      save t/count
        call add
          read t/count
          code 2
  call fire
    read t
  fork test
    hook test
      call is-above
        read t/count
        code 5
    hook hold
      halt outage
        bind thing, text <power>
  send back, text <fired {t/count}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-shadowed-callee-'))
const resolve = projectResolver(process.cwd(), 'rust')
const result = compile({ file: join(dir, 'shadowed.tree'), text: PROGRAM }, { resolve, env: 'rust' })

ok('compiles', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).slice(0, 4).join(' | '))

if (result.ok) {
  const exceptions = ['exception', 'absence', 'outage', 'failure']
  const ts = raiseSetsOf(result.program, exceptions)
  const tree = raiseSetsOfTree(result.program as never, exceptions) as { raises: Map<string, string[]> }

  ok('effects.ts: run raises outage', (ts.raises.get('run') ?? []).includes('outage'), JSON.stringify(ts.raises.get('run')))
  ok('effects.ts: fire raises nothing', (ts.raises.get('fire') ?? ['missing']).length === 0, JSON.stringify(ts.raises.get('fire')))
  ok('effects.tree: run raises outage', (tree.raises.get('run') ?? []).includes('outage'), JSON.stringify(tree.raises.get('run')))
  ok('effects.tree: fire raises nothing', (tree.raises.get('fire') ?? ['missing']).length === 0, JSON.stringify(tree.raises.get('fire')))

  const rust = emitRust(result.program)
  const signature = rust.split('\n').find(line => /fn fire\b/.test(line)) ?? ''
  ok('rust: fire is infallible', signature !== '' && !signature.includes('Result'), signature)
  ok('rust: no `run()?` in fire', !/\brun\(\)\?/.test(rust), '')
}

const only = process.env.SC_ONLY

for (const backend of BACKENDS.filter(one => !only || one === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'shadowed' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: a walk local named like a raising task builds and runs`, ran.form === 'ran' && ran.output === 'fired 3', ran.form === 'ran' ? ran.output : `${ran.stage}: ${ran.reason}`)
}

console.log(`\nshadowed-callee: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
