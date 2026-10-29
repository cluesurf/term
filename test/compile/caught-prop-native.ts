// A prop read off a caught value, `problem/link/actual`, on every backend. The carrier's `link` is the record of
// whichever exception was raised, which TypeScript reads as an object and the native backends hold boxed (`Rc<dyn Any>`
// on Rust, `Any?` on Swift and Kotlin). Each native emitter reads the prop out of every exception form whose link has
// it, matching the raised record the carrier keeps in `base` (`caught-prop` in compile/rust-emit.tree, swift-emit.tree,
// kotlin-emit.tree). Until 2026-10-22 it compiled on TypeScript alone: rustc said "no field `actual` on type
// `Rc<dyn Any>`", Swift "value of type 'Any?' has no member 'actual'", Kotlin "unresolved reference" (gaps 65, 168).
// Run: npx tsx test/compile/caught-prop-native.ts   (CAUGHT_ONLY=typescript, rust, swift or kotlin runs one)

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

type Case = {
  name: string
  says: string
  want: string
  program: string
}

const CASES: Case[] = [
  {
    name: 'prop',
    says: 'a number prop and a text prop read off a caught excess',
    want: 'excess 9 n',
    program: `load @term/base/exception
  find excess

task check
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt excess
        bind thing, text <n>
        bind limit, code 3
        bind actual, read n
  back n

task run
  like text
  save answer, <none>
  fork
    mark unsafe
    save got, check(9)
  halt take
    take problem
    save answer, <{problem/form} {problem/link/actual} {problem/link/thing}>
  back answer
`,
  },
  {
    name: 'two-forms',
    says: 'a prop two exception forms share is read off whichever was raised',
    want: 'timeout late',
    program: `load @term/base/exception
  find excess
  find timeout

task check
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt timeout
        bind thing, text <late>
        bind waited, code 5
  halt excess
    bind thing, text <big>
    bind limit, code 3
    bind actual, read n

task run
  like text
  save answer, <none>
  fork
    mark unsafe
    save got, check(9)
  halt take
    take problem
    save answer, <{problem/form} {problem/link/thing}>
  back answer
`,
  },
]

const dir = mkdtempSync(join(tmpdir(), 'term-caught-prop-'))
const only = process.env.CAUGHT_ONLY ?? ''

for (const one of CASES) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const ran = runOn({
      backend,
      program: one.program,
      resolve: env => projectResolver(process.cwd(), env),
      dir,
      name: one.name,
    })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `${backend}: ${one.says} (${one.name})`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran'
        ? `got ${JSON.stringify(ran.output)}`
        : `${ran.stage}: ${ran.reason.slice(0, 600)}`,
    )
  }
}

console.log(`\ncaught-prop-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
