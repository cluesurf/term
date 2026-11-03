// THE NATIVE RUNS OF A TYPE NAMED IN A SIFT'S ARM (item term-self-host-001-0830, term/compiler decision 012). A form named only under a
// `case list` / `like point` was dropped by the tree shake, which reads names through compile/node-reach.tree, and a form two files
// define was left under its written name by check/scope's binding, so these programs were refused. Each answers one text, the same on
// all four backends, through the real toolchain. The walks themselves are test/compile/arm-type-reached.tree.
// Run from deck/term/deck/term: npx tsx test/compile/arm-type-native.ts   (ARM_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import type { Resolver, Source } from '@term/make/code/compile/load'
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

const LIST = `load @term/base/list
  find push
`

const PICK_LIST = `task pick
  take value, like unknown
  like text

  sift value
    case list
      like point
      link items
      back <list {items/length}>
    miss
      back <miss>
`

const A = `${LIST}
form point
  link x, like number

task make-a
  like unknown

  save one
    make point
      bind x, 1
  back one

task make-as
  like unknown

  save out, make list
  save one
    make point
      bind x, 1
  push(out, one)
  back out
`

const B = `${LIST}
form point
  link name, like text

task make-b
  like unknown

  save one
    make point
      bind name, <n>
  back one

task make-bs
  like unknown

  save out, make list
  save one
    make point
      bind name, <n>
  push(out, one)
  back out
`

type Case = {
  name: string
  want: string
  files: Record<string, string>
  main: string
}

const cases: Case[] = [
  {
    name: 'a form imported and named only in a list arm',
    want: 'miss',
    files: { './shapes': 'form point\n  link x, like number\n\nform other\n  link y, like number\n' },
    main: `load ./shapes\n  find point\n\n${PICK_LIST}\ntask run\n  like text\n\n  back pick(3)\n`,
  },
  {
    name: 'an arm in a dependency, its form private to it',
    want: 'miss',
    files: { './dep': `form point\n  link x, like number\n\n${PICK_LIST}` },
    main: `load ./dep\n  find pick\n\ntask run\n  like text\n\n  back pick(3)\n`,
  },
  {
    name: "a list arm over a form two files define takes the one its file finds",
    want: 'list 1,miss',
    files: { './a': A, './b': B },
    main: `load ./a\n  find point\n  find make-as\n\nload ./b\n  find make-bs\n\n${PICK_LIST}\ntask run\n  like text\n\n  back <{pick(make-as())},{pick(make-bs())}>\n`,
  },
  {
    name: "a form's own arm over a form two files define takes the one its file finds",
    want: 'a 1,miss',
    files: { './a': A, './b': B },
    main: `load ./a\n  find point\n  find make-a\n\nload ./b\n  find make-b\n\ntask pick\n  take value, like unknown\n  like text\n\n  sift value\n    case point\n      back <a {value/x}>\n    miss\n      back <miss>\n\ntask run\n  like text\n\n  back <{pick(make-a())},{pick(make-b())}>\n`,
  },
]

const only = process.env.ARM_ONLY
const dir = mkdtempSync(join(tmpdir(), 'arm-type-native-'))

for (const [at, one] of cases.entries()) {
  const resolve = (env: NativeEnv): Resolver => {
    const stdlib = withNativeEnv(env, stdlibResolver()!) as (path: string, from?: string) => Source | undefined
    return ((path: string, from?: string): Source | undefined => {
      const text = one.files[path]
      return text === undefined ? stdlib(path, from) : { file: `${path.slice(2)}.tree`, text }
    }) as Resolver
  }

  for (const backend of BACKENDS) {
    if (only && only !== backend) continue
    const ran = runOn({ backend, program: one.main, resolve, dir, name: `case${at}` })
    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${one.name}: ${ran.reason}`)
      continue
    }
    ok(
      `${backend}: ${one.name}`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran' ? `answered ${ran.output}` : `${ran.stage}: ${ran.reason}`,
    )
  }
}

console.log(`\narm-type-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
