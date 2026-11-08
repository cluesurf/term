// @term/base/bit on node and on browser, as an emitted program reaches it, held to the BigInt reference it must equal,
// on edges and on random values. A probe that loads @term/base/bit is compiled for each env with the stdlib's own
// resolver, the native prelude it would ship with is put in front, and each public op is called through the probe's
// task: so whatever native/<env>/bit.tree holds (host binds, or a dock of a runtime shim) is what is checked, never a
// file read by path. Both envs' binds are plain JavaScript, so the browser program runs here too.
// Run: npx tsx test/compile/bit-shim.ts

import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'

const BINARY = [
  ['and', 'bitwise-and'],
  ['or', 'bitwise-or'],
  ['exclusive-or', 'bitwise-exclusive-or'],
  ['multiply-32', 'multiply-32'],
]
const SHIFTS = [
  ['shift-left', 'shift-left'],
  ['shift-right', 'shift-right'],
  ['shift-right-unsigned', 'unsigned-shift-right'],
]

const PROBE = `load @term/base/bit
  find bitwise-and
  find bitwise-or
  find bitwise-exclusive-or
  find bitwise-not
  find shift-left
  find shift-right
  find unsigned-shift-right
  find multiply-32

${BINARY.map(
  ([name, op]) => `task probe-${name}
  take left, like number
  take right, like number
  like number
  send back
    call ${op}
      read left
      read right
`,
).join('\n')}
task probe-not
  take value, like number
  like number
  send back
    call bitwise-not
      read value

${SHIFTS.map(
  ([name, op]) => `task probe-${name}
  take value, like number
  take count, like number
  like number
  send back
    call ${op}
      read value
      read count
`,
).join('\n')}`

type Op = (a: number, b: number) => number

// the probe's emitted task for each op, by the reference's name
const PROBE_TASK: Record<string, string> = {
  and: 'probeAnd',
  or: 'probeOr',
  exclusiveOr: 'probeExclusiveOr',
  not: 'probeNot',
  shiftLeft: 'probeShiftLeft',
  shiftRight: 'probeShiftRight',
  shiftRightUnsigned: 'probeShiftRightUnsigned',
  multiply32: 'probeMultiply32',
}

const big = (x: number): bigint => BigInt(Math.trunc(x))
const ref: Record<string, Op> = {
  and: (a, b) => Number(BigInt.asIntN(64, big(a) & big(b))),
  or: (a, b) => Number(BigInt.asIntN(64, big(a) | big(b))),
  exclusiveOr: (a, b) => Number(BigInt.asIntN(64, big(a) ^ big(b))),
  not: a => Number(BigInt.asIntN(64, ~big(a))),
  shiftLeft: (a, b) => Number(BigInt.asIntN(64, big(a) << big(b))),
  shiftRight: (a, b) => Number(BigInt.asIntN(64, big(a) >> big(b))),
  shiftRightUnsigned: (a, b) =>
    Number(BigInt.asUintN(64, big(a)) >> big(b)),
  // the signed 32-bit product with the high bits discarded, which Math.imul is on integers
  multiply32: (a, b) => Number(BigInt.asIntN(32, big(a) * big(b))),
}

const edges = [
  0,
  -0,
  1,
  -1,
  2,
  -2,
  255,
  0x7fffffff,
  -0x80000000,
  0x80000000,
  0xffffffff,
  0x100000000,
  -0x80000001,
  2 ** 52,
  -(2 ** 52),
  2 ** 53 - 1,
  -(2 ** 53 - 1),
  12345678901,
  -98765432109,
]
let seed = 7
const random = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  const kind = seed % 4
  const r = seed / 2147483648
  return kind === 0
    ? Math.floor(r * 2 ** 31) * (seed % 2 ? 1 : -1)
    : kind === 1
      ? Math.floor(r * 2 ** 32)
      : kind === 2
        ? Math.floor(r * 2 ** 53) * (seed % 3 ? 1 : -1)
        : Math.floor(r * 300) - 150
}
const values = [...edges, ...Array.from({ length: 3000 }, random)]
const counts = [0, 1, 2, 5, 16, 31, 32, 33, 52, 53, 62, 63, 64, 70]

const readRuntime = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined
const dir = mkdtempSync(join(tmpdir(), 'term-bit-shim-'))

let checked = 0
let wrong = 0

function fail(message: string): void {
  wrong++

  if (wrong < 10) {
    console.log(message)
  }
}

// the probe compiled for `env`, its ops called from here
function opsOn(env: NativeEnv): Record<string, Op> | undefined {
  const result = compile(
    { file: join(dir, `probe-${env}.tree`), text: PROBE },
    { resolve: projectResolver(process.cwd(), env), env },
  )

  if (!result.ok) {
    fail(
      `FAIL  ${env}: the probe compiles: ${[...new Set(result.diagnostics.map(d => d.message))].slice(0, 4).join(' | ')}`,
    )
    return undefined
  }

  const prelude = nativePrelude(
    result.program,
    env,
    readRuntime,
    result.typescript,
  )
  const js = transformSync(`${prelude}\n${result.typescript}\n`, {
    loader: 'ts',
    format: 'cjs',
  }).code
  const module = { exports: {} as Record<string, unknown> }
  new Function('module', 'exports', js)(module, module.exports)
  // which implementation the program carries: the runtime shim's helpers are in its prelude only when it is docked
  console.log(
    `${env}: the program carries ${/__bitSigned32/.test(prelude) ? 'the runtime shim' : 'no runtime shim'}`,
  )
  const ops: Record<string, Op> = {}

  for (const [name, task] of Object.entries(PROBE_TASK)) {
    const op = module.exports[task]

    if (typeof op !== 'function') {
      fail(`FAIL  ${env}: the probe exports ${task}`)
      return undefined
    }

    ops[name] = op as Op
  }

  return ops
}

for (const env of ['node', 'browser'] as NativeEnv[]) {
  const bit = opsOn(env)

  if (!bit) {
    continue
  }

  for (const name of Object.keys(ref)) {
    const rights = name.startsWith('shift')
      ? counts
      : name === 'not'
        ? [0]
        : values.slice(0, 400)
    let opChecked = 0
    let opWrong = 0

    for (const a of values) {
      for (const b of rights) {
        const got = bit[name]!(a, b)
        const want = ref[name]!(a, b)
        checked++
        opChecked++

        if (!Object.is(got, want) && !(got === 0 && want === 0)) {
          opWrong++
          fail(`FAIL  ${env} ${name}(${a}, ${b}) = ${got}, want ${want}`)
        }
      }
    }

    console.log(
      `${opWrong ? 'FAIL' : 'ok  '}  ${env} ${name}: ${opChecked} checked, ${opWrong} wrong`,
    )
  }
}

console.log(`bit-check: ${checked} checked, ${wrong} wrong`)
process.exit(wrong || checked === 0 ? 1 : 0)
