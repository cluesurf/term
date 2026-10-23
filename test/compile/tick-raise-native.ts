// `tick` of an async task that can RAISE (term-decisions-2026-10-seam-0021). Rust wrote the raise's `?` (or its
// `.map_err(..)?`, or the unhandled `.unwrap_or_else`) on the call's FUTURE, before `__term_spawn` took it, and rustc
// refused it: `no method named map_err found for opaque type impl Future<Output = Result<(), TermException>>`. It
// surfaced in site's terminal blog once view/render.tree loaded @term/base/exception, which made the blog's
// `add-post` count `failure`, and its click handler ticks it. A ticked call's raise is the queued work's, so the
// spawned future is the call's own, awaited inside the work and a raise there handled as an unhandled raise, as the
// runtime's `__term_spawn` says queued work does.
// Run: npx tsx test/compile/tick-raise-native.ts   (TR_ONLY=typescript, rust, swift or kotlin runs one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
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

form outage
  like absence
    bind note, <down>

form tally
  mark shared
  link count, like number

# async, and raises on a negative step
task post
  mark async
  take t, like tally
  take step, like number
  fork test
    hook test
      call is-below
        read step
        code 0
    hook hold
      halt outage
        bind thing, text <step>
  save t/count
    call add
      read t/count
      read step

# starts the post and does not wait for it, as a click handler does
task press
  take t, like tally
  tick post
    read t
    code 2

task run
  like text
  save t
    make tally
      bind count, 1
  call press
    read t
  send back, text <count {t/count}>
`

const only = process.env.TR_ONLY
const dir = mkdtempSync(join(tmpdir(), 'term-tick-raise-'))

for (const backend of BACKENDS.filter(one => !only || one === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'tick-raise' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: a ticked raising task builds, starts and runs`, ran.form === 'ran' && ran.output === 'count 3', ran.form === 'ran' ? ran.output : `${ran.stage}: ${ran.reason}`)
}

console.log(`\ntick-raise-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
