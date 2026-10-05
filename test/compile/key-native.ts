// The two equalities of a float, on every backend: a KEY has one NaN and `-0.0` is `0.0` (TypeScript's
// `__termKeyText`), and a VALUE compares by IEEE, NaN unequal to itself and the two zeros equal (`__termEqual`).
// Rust keys through `TermHash` (compile/rust.ts), Swift through `TermKeyBox` / `TermKeyed` in the map runtime
// (compile/swift.ts), Kotlin through `termKey` at a map access and a float-holding record's own `equals`, with
// `is-equal` over one as `termEqual` (compile/kotlin.ts, the `key` helper). Each program prints one line, and every
// backend must print what is written here, which is what TypeScript prints.
// Run: npx tsx test/compile/key-native.ts   (KEY_ONLY=typescript, rust, swift or kotlin runs one)

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

type Case = { name: string; says: string; want: string; program: string }

const CASES: Case[] = [
  {
    name: 'nan-key',
    says: 'a NaN key set twice is one entry and is found again, and -0.0 overwrites 0.0',
    want: 'size 2, nan 2, zero 4',
    program: `load @term/base/float
  find square-root

load @term/base/hash
  find hash
  find size
  find get-or-default

task run
  like text
  save nan, square-root(-1.0)
  save keys, make hash
  set keys, nan, 1
  set keys, nan, 2
  save zero, 0.0
  save negative, multiply(zero, -1.0)
  set keys, zero, 3
  set keys, negative, 4
  send back, <size {size(keys)}, nan {get-or-default(keys, nan, 0)}, zero {get-or-default(keys, zero, 0)}>
`,
  },
  {
    name: 'nan-record-key',
    says: 'a record key holding NaN is one entry and is found again, and a record holding -0.0 is the one holding 0.0',
    want: 'size 2, nan 2, zero 4',
    program: `load @term/base/float
  find square-root

load @term/base/hash
  find hash
  find size
  find get-or-default

form point
  link x, like decimal

task run
  like text
  save nan, square-root(-1.0)
  save keys, make hash
  set keys, make(point, bind(x, nan)), 1
  set keys, make(point, bind(x, nan)), 2
  set keys, make(point, bind(x, 0.0)), 3
  set keys, make(point, bind(x, multiply(0.0, -1.0))), 4
  send back, <size {size(keys)}, nan {get-or-default(keys, make(point, bind(x, nan)), 0)}, zero {get-or-default(keys, make(point, bind(x, 0.0)), 0)}>
`,
  },
  {
    name: 'list-record-key',
    says: 'a record key holding a list is one entry for two equal lists',
    want: 'size 1',
    program: `load @term/base/hash
  find hash
  find size

load @term/base/list
  find list

form path
  link parts, like list, like text

task run
  like text
  save keys, make hash
  set keys, make(path, bind(parts, make(list, <a>, <b>))), 1
  set keys, make(path, bind(parts, make(list, <a>, <b>))), 2
  send back, <size {size(keys)}>
`,
  },
  {
    name: 'hash-record-key',
    says: 'a record key holding a hash is one entry for two equal hashes, and another for a different one',
    want: 'size 2',
    program: `load @term/base/hash
  find hash
  find size
  find set

form tally
  link counts, like hash, like text, like number

task make-tally
  take n, like number
  like tally
  save counts, make hash
  set counts, <a>, n
  back make(tally, bind(counts, counts))

task run
  like text
  save keys, make hash
  set keys, make-tally(1), 1
  set keys, make-tally(1), 2
  set keys, make-tally(2), 3
  send back, <size {size(keys)}>
`,
  },
  {
    name: 'nan-field',
    says: 'is-equal on two records holding NaN is false, and on records holding 0.0 and -0.0 is true',
    want: 'same nan false, signed zero true, nan itself false',
    program: `load @term/base/float
  find square-root

form point
  link x, like decimal

task run
  like text
  save nan, square-root(-1.0)
  save a, make(point, bind(x, nan))
  save b, make(point, bind(x, nan))
  save p, make(point, bind(x, 0.0))
  save q, make(point, bind(x, multiply(0.0, -1.0)))
  send back, <same nan {is-equal(a, b)}, signed zero {is-equal(p, q)}, nan itself {is-equal(nan, nan)}>
`,
  },
  {
    name: 'nan-case',
    says: 'the same, for a case of a form with cases',
    want: 'same nan false, signed zero true',
    program: `load @term/base/float
  find square-root

form shape
  case circle
    link radius, like decimal
  case dot

task run
  like text
  save nan, square-root(-1.0)
  save a, make(circle, bind(radius, nan))
  save b, make(circle, bind(radius, nan))
  save p, make(circle, bind(radius, 0.0))
  save q, make(circle, bind(radius, multiply(0.0, -1.0)))
  send back, <same nan {is-equal(a, b)}, signed zero {is-equal(p, q)}>
`,
  },
  {
    name: 'float-list-equal',
    says: 'the same, for two lists of floats',
    want: 'same nan false, signed zero true',
    program: `load @term/base/float
  find square-root

load @term/base/list
  find list

task run
  like text
  save nan, square-root(-1.0)
  save a, make list, nan, 1.0
  save b, make list, nan, 1.0
  save p, make list, 0.0
  save q, make list, multiply(0.0, -1.0)
  send back, <same nan {is-equal(a, b)}, signed zero {is-equal(p, q)}>
`,
  },
]

const dir = mkdtempSync(join(tmpdir(), 'term-key-native-'))
const only = process.env.KEY_ONLY ?? ''

for (const one of CASES) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const ran = runOn({ backend, program: one.program, resolve: env => projectResolver(process.cwd(), env), dir, name: one.name })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `${backend}: ${one.says} (${one.name})`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
    )
  }
}

console.log(`\nkey-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
