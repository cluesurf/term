// A name first saved in every arm of a `sift` (or of a `fork`) is scoped to its arm, on the checker and on every
// backend: TypeScript declares it inside the arm's block, Rust, Swift and Kotlin the same. The resolver refuses a read
// of it after the branch, except where a lean call leaves an unbound bare word for the checker to read as a flag: a
// call with no signature (a list builtin, a method on a receiver) never reached the flag check, so
// `push(names, found)` after the branch compiled, and TypeScript threw `ReferenceError: found is not defined` at run
// time while rustc, swiftc and kotlinc refused the emitted read (trap T-0232, item term-self-host-001-0430). Refused
// now by name on every backend, and the written-right shape (saved before the branch with a default, reassigned in
// the arms) runs on all four.
// Run: npx tsx test/compile/arm-saved-name.ts   (ARM_ONLY=typescript, rust, swift or kotlin runs one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import type { NativeEnv } from '@term/make/code/compile/native'
import { BACKENDS, runOn } from './shared/run-on'
import type { Backend } from './shared/run-on'

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

const LIST = `load @term/base/list
  find list
  find get

`

const SHAPE = `form shape
  case circle
    link radius, like number
  case square
    link side, like number

`

// the read after the branch, by a list builtin and by a method on its receiver
const READS: Record<string, string> = {
  push: 'push(names, found)',
  method: 'names/push(found)',
}

// a name first saved in every arm, read after the branch
const ARMS_ONLY = (read: string): Record<string, string> => ({
  sift: `${LIST}${SHAPE}task size
  take s, like shape
  like number
  save names, make list
  sift s
    case circle
      save found, radius
    miss
      save found, 0
  ${read}
  back get(names, 0)
`,
  fork: `${LIST}task pick
  take n, like number
  like number
  save names, make list
  fork test, is-above(n, 2)
    hold
      save found, 1
    miss
      save found, 2
  ${read}
  back get(names, 0)
`,
})

// the same, saved before the branch with a default and only reassigned in the arms
const HOISTED = `${LIST}${SHAPE}task size
  take s, like shape
  like number
  save names, make list
  save found, 0
  sift s
    case circle
      save found, radius
    case square
      save found, side
  push(names, found)
  back get(names, 0)

task pick
  take n, like number
  like number
  save names, make list
  save found, 0
  fork test, is-above(n, 2)
    hold
      save found, 1
    miss
      save found, 2
  names/push(found)
  back get(names, 0)

task run
  like text
  back <{size(make(circle, 3))}|{size(make(square, 7))}|{pick(5)}|{pick(1)}>
`

const ENV: Record<Backend, NativeEnv> = {
  typescript: 'node',
  rust: 'rust',
  swift: 'swift',
  kotlin: 'kotlin',
}

const only = process.env.ARM_ONLY
const here = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-arm-saved-name-'))

for (const backend of BACKENDS.filter(one => !only || one === only)) {
  const env = ENV[backend]

  for (const [readLabel, read] of Object.entries(READS)) {
    for (const [branch, program] of Object.entries(ARMS_ONLY(read))) {
      const result = compile(
        {
          file: join(dir, `${branch}-${readLabel}.tree`),
          text: program,
        },
        {
          resolve: projectResolver(here, env),
          env,
          leanOf: () => true,
        },
      )
      ok(
        `${backend}: a name saved only in the arms of a ${branch}, read by ${read}, is refused by name`,
        !result.ok &&
          result.diagnostics.some(
            d =>
              d.name === 'unknown-name' &&
              d.message === 'the name "found" is not defined',
          ),
        result.ok
          ? 'compiled'
          : result.diagnostics
              .map(d => `${d.name}: ${d.message}`)
              .join(' | '),
      )
    }
  }

  const ran = runOn({
    backend,
    program: HOISTED,
    resolve: one => projectResolver(here, one),
    dir,
    name: 'hoisted',
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: the name saved before the branch and reassigned in its arms is read after it`,
    ran.form === 'ran' && ran.output === '3|7|1|2',
    ran.form === 'ran' ? ran.output : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\narm-saved-name: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
