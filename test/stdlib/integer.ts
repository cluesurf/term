// Sized-integer tests: compile the real base.tree fixed-width integer modules (i8 / i16 / i32 / u8 / u16 / u32) and run
// the emitted TypeScript, asserting wrapping, checked, and saturating arithmetic. The whole tower is one `tree` template
// (code/integer/n.tree) fused per width with its mask / sign / bounds; every operation reduces through the native `bit`
// module, so there is no per-width native code and no runtime shim. Run: npx tsx test/stdlib/integer.ts

import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import { render } from '@term/make/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', 'deck', 'seed')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/seed/'
  path = path.replace(/^@term\/seed\//, prefix)

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  const prefix = '@cluesurf/seed/'
  path = path.replace(/^@term\/seed\//, prefix)

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, path.slice(prefix.length))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

let pass = 0
let fail = 0

function eq(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

async function load(
  file: string,
): Promise<Record<string, (...a: number[]) => unknown>> {
  const text = readFileSync(join(baseTree, 'code', file), 'utf8')
  const result = compile(
    { file: 'main.tree', text },
    { resolve: withNativeEnv('node', stdlib) },
  )

  if (!result.ok) {
    for (const d of result.diagnostics) {
      console.log(render(d, text.split('\n'), false))
    }

    throw new Error(`compile failed: ${file}`)
  }

  const ts =
    nativePrelude(result.program, 'node', readRuntime) +
    '\n' +
    result.typescript
  const dir = mkdtempSync(join(tmpdir(), 'seed-integer-'))
  const out = join(dir, 'm.ts')
  writeFileSync(out, ts)

  return (await import(pathToFileURL(out).href)) as Record<
    string,
    (...a: number[]) => unknown
  >
}

async function main(): Promise<void> {
  const i8 = await load('integer/8.tree')
  eq('i8 add wraps (100 + 50 = -106)', i8.i8Add(100, 50), -106)
  eq('i8 add wraps negative (-100 + -50 = 106)', i8.i8Add(-100, -50), 106)
  eq('i8 add in range (10 + 20 = 30)', i8.i8Add(10, 20), 30)
  eq('i8 bounds (-128 .. 127)', [
    i8.i8MinimumValue(),
    i8.i8MaximumValue(),
  ], [-128, 127])
  eq('i8 checked add overflows to none', i8.i8CheckedAdd(100, 50), {
    form: 'none',
  })
  eq('i8 checked add in range', i8.i8CheckedAdd(10, 20), {
    form: 'some',
    value: 30,
  })
  eq('i8 saturating add clamps to max', i8.i8SaturatingAdd(100, 50), 127)
  eq('i8 negate of min is min (two-complement)', i8.i8Negate(-128), -128)

  const i16 = await load('integer/16.tree')
  eq('i16 add wraps (32767 + 1)', i16.i16Add(32767, 1), -32768)
  eq('i16 multiply wraps (200 * 200)', i16.i16Multiply(200, 200), -25536)

  const i32 = await load('integer/32.tree')
  eq('i32 add wraps (2147483647 + 1)', i32.i32Add(2147483647, 1), -2147483648)
  eq(
    'i32 saturating add clamps',
    i32.i32SaturatingAdd(2147483647, 1),
    2147483647,
  )
  eq('i32 checked add overflows to none', i32.i32CheckedAdd(2147483647, 1), {
    form: 'none',
  })

  const u = await load('integer/unsigned.tree')
  eq('u8 add wraps (255 + 1 = 0)', u.u8Add(255, 1), 0)
  eq('u8 maximum is 255', u.u8MaximumValue(), 255)
  eq('u8 saturating add clamps to 255', u.u8SaturatingAdd(255, 10), 255)
  eq('u16 add wraps (65535 + 2 = 1)', u.u16Add(65535, 2), 1)
  eq('u32 maximum is 4294967295', u.u32MaximumValue(), 4294967295)
  eq('u8 is-negative is always false', u.u8IsNegative(200), false)

  // 64-bit: the native platform integer (no masking)
  const i64 = await load('integer/64.tree')
  eq('i64 add (native)', i64.i64Add(1000000000, 2000000000), 3000000000)
  eq('i64 negate', i64.i64Negate(42), -42)
  eq('i64 minimum bound', i64.i64MinimumValue(), -9223372036854775808)
  eq('u64 minimum is 0', i64.u64MinimumValue(), 0)

  // floats: f32 rounds every result to single precision; f64 is the native double
  const f32 = await load('float/32.tree')
  eq(
    'f32 add rounds to single precision',
    f32.f32Add(0.1, 0.2),
    Math.fround(0.1 + 0.2),
  )
  eq('f32 multiply rounds', f32.f32Multiply(1.1, 1.1), Math.fround(1.1 * 1.1))
  const f64 = await load('float/64.tree')
  eq('f64 add is the native double', f64.f64Add(0.1, 0.2), 0.1 + 0.2)
  eq('f64 divide is the native double', f64.f64Divide(1, 4), 0.25)

  // arbitrary-precision integers via native bignum (BigInt on node)
  const big = await load('integer/big.tree')
  const a = big.makeBigInteger('123456789012345678901234567890')
  const b = big.makeBigInteger('987654321')
  eq(
    'big-integer exact multiply (30-digit x 9-digit)',
    big.bigIntegerText(big.bigIntegerMultiply(a, b)),
    (123456789012345678901234567890n * 987654321n).toString(),
  )
  eq(
    'big-integer divide truncates',
    big.bigIntegerText(big.bigIntegerDivide(a, b)),
    (123456789012345678901234567890n / 987654321n).toString(),
  )
  eq('big-integer compare a > b', big.bigIntegerCompare(a, b), 1)

  // arbitrary-precision decimals (exact base-10, no binary float rounding) via a BigInt-scaled fixed-point
  const dec = await load('decimal.tree')
  eq(
    'decimal 0.1 + 0.2 = 0.3 exactly (no 0.30000000000000004)',
    dec.bigDecimalText(
      dec.bigDecimalAdd(dec.makeBigDecimal('0.1'), dec.makeBigDecimal('0.2')),
    ),
    '0.3',
  )
  eq(
    'decimal 1.00 - 0.99 = 0.01',
    dec.bigDecimalText(
      dec.bigDecimalSubtract(
        dec.makeBigDecimal('1.00'),
        dec.makeBigDecimal('0.99'),
      ),
    ),
    '0.01',
  )
  eq(
    'decimal 2.5 * 4 = 10.0 (scales add)',
    dec.bigDecimalText(
      dec.bigDecimalMultiply(dec.makeBigDecimal('2.5'), dec.makeBigDecimal('4')),
    ),
    '10.0',
  )

  console.log(`\nnumerics: ${pass} pass, ${fail} fail`)
}

main()
