// The float type, balanced-ternary floating point: a value is mantissa * 3^exponent, the mantissa an exact
// balanced-ternary integer (bigint), the exponent an integer. The Setun lineage, updated. Truncation rounds to
// nearest with no bias (the gift of balanced ternary), so there is no round-half rule. Precision is a trit count.

import { tritLength, tritString } from '@/code/engine/data/trit'

export type TernaryFloat = {
  readonly mantissa: bigint // balanced-ternary integer
  readonly exponent: number // power of 3
}

const DEFAULT_PRECISION = 24 // trits of mantissa kept (about 11 decimal digits)

// drop trailing zero-trits (factors of 3) from the mantissa, raising the exponent, the normal form
function normalize(mantissa: bigint, exponent: number): TernaryFloat {
  if (mantissa === 0n) return { mantissa: 0n, exponent: 0 }
  let m = mantissa
  let e = exponent
  while (m % 3n === 0n) {
    m /= 3n
    e += 1
  }
  return { mantissa: m, exponent: e }
}

// keep the mantissa within `precision` trits, rounding the low trits away (balanced truncation = round to nearest)
function round(value: TernaryFloat, precision: number): TernaryFloat {
  const len = tritLength(value.mantissa)
  if (len <= precision) return value
  const drop = len - precision
  const scale = 3n ** BigInt(drop)
  // round to nearest by adding half the scale toward the sign before the integer divide
  const half = scale / 2n
  const m = value.mantissa
  const rounded = (m >= 0n ? m + half : m - half) / scale
  return normalize(rounded, value.exponent + drop)
}

export function float(mantissa: bigint, exponent = 0): TernaryFloat {
  return normalize(mantissa, exponent)
}

// from a JS number: pull out a base-3 mantissa and exponent within the precision
export function fromNumber(
  value: number,
  precision = DEFAULT_PRECISION,
): TernaryFloat {
  if (value === 0 || !Number.isFinite(value))
    return { mantissa: 0n, exponent: 0 }
  // scale up by 3^precision, round to an integer mantissa, exponent = -precision, then normalize
  const scale = 3 ** precision
  const mantissa = BigInt(Math.round(value * scale))
  return round(normalize(mantissa, -precision), precision)
}

export function toNumber(value: TernaryFloat): number {
  return Number(value.mantissa) * 3 ** value.exponent
}

export function negate(a: TernaryFloat): TernaryFloat {
  return { mantissa: -a.mantissa, exponent: a.exponent }
}

export function add(
  a: TernaryFloat,
  b: TernaryFloat,
  precision = DEFAULT_PRECISION,
): TernaryFloat {
  if (a.mantissa === 0n) return round(b, precision)
  if (b.mantissa === 0n) return round(a, precision)
  // align to the lower exponent, then add the integer mantissas exactly
  const e = Math.min(a.exponent, b.exponent)
  const am = a.mantissa * 3n ** BigInt(a.exponent - e)
  const bm = b.mantissa * 3n ** BigInt(b.exponent - e)
  return round(normalize(am + bm, e), precision)
}

export function subtract(
  a: TernaryFloat,
  b: TernaryFloat,
  precision = DEFAULT_PRECISION,
): TernaryFloat {
  return add(a, negate(b), precision)
}

export function multiply(
  a: TernaryFloat,
  b: TernaryFloat,
  precision = DEFAULT_PRECISION,
): TernaryFloat {
  return round(
    normalize(a.mantissa * b.mantissa, a.exponent + b.exponent),
    precision,
  )
}

export function compare(a: TernaryFloat, b: TernaryFloat): -1 | 0 | 1 {
  const d = toNumber(subtract(a, b))
  return d < 0 ? -1 : d > 0 ? 1 : 0
}

// the balanced-ternary mantissa glyphs with the exponent, e.g. "+0- x3^-2"
export function toString(a: TernaryFloat): string {
  if (a.mantissa === 0n) return '0'
  return `${tritString(a.mantissa)} x3^${a.exponent}`
}
