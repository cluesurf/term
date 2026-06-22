// The integer type, balanced ternary, multi-resolution (like Postgres int2 / int4 / int8, but base 3). The VALUE
// is an exact bigint, so arithmetic is exact and optimal. The RESOLUTION is a storage width: `tri8` / `tri16` /
// `tri40` are fixed words (tri40 ~ a 64-bit range), `big` is unbounded (the self-extending case). Operations stay
// exact by PROMOTING to the smallest resolution that fits the result, so the common case (small numbers) is a
// short word and every other case still works.

import {
  toTrits,
  fromTrits,
  tritString,
  tritLength,
  tritWordRange,
  type Trit,
} from '@cluesurf/make/code/engine/data/trit'

export type Resolution = 'tri8' | 'tri16' | 'tri40' | 'big'

export const RESOLUTION_WIDTH: Record<
  'tri8' | 'tri16' | 'tri40',
  number
> = { tri8: 8, tri16: 16, tri40: 40 }
const FIXED: Resolution[] = ['tri8', 'tri16', 'tri40']

export type TernaryInteger = {
  readonly value: bigint
  readonly resolution: Resolution
}

// the smallest resolution that holds a value (by balanced-ternary length), falling back to big
export function fitResolution(value: bigint): Resolution {
  const len = tritLength(value)

  for (const r of FIXED) {
    if (len <= RESOLUTION_WIDTH[r as 'tri8' | 'tri16' | 'tri40']) {
      return r
    }
  }

  return 'big'
}

// make an integer. With no resolution, the smallest fitting one is chosen. With a fixed resolution, the value
// must fit (else it throws, like a typed column overflow).
export function integer(
  value: number | bigint,
  resolution?: Resolution,
): TernaryInteger {
  const v = typeof value === 'bigint' ? value : BigInt(value)

  if (resolution && resolution !== 'big') {
    const width = RESOLUTION_WIDTH[resolution]
    const { min, max } = tritWordRange(width)

    if (v < min || v > max) {
      throw new Error(
        `value ${v} does not fit ${resolution} (width ${width})`,
      )
    }

    return { value: v, resolution }
  }

  return { value: v, resolution: resolution ?? fitResolution(v) }
}

const wrap = (v: bigint): TernaryInteger => ({
  value: v,
  resolution: fitResolution(v),
})

// arithmetic, exact, result promoted to the smallest fitting resolution
export function add(
  a: TernaryInteger,
  b: TernaryInteger,
): TernaryInteger {
  return wrap(a.value + b.value)
}

export function subtract(
  a: TernaryInteger,
  b: TernaryInteger,
): TernaryInteger {
  return wrap(a.value - b.value)
}

export function multiply(
  a: TernaryInteger,
  b: TernaryInteger,
): TernaryInteger {
  return wrap(a.value * b.value)
}

export function negate(a: TernaryInteger): TernaryInteger {
  return { value: -a.value, resolution: a.resolution }
}

export function absolute(a: TernaryInteger): TernaryInteger {
  return wrap(a.value < 0n ? -a.value : a.value)
}

// truncating division and the matching remainder (toward zero), exact
export function divide(
  a: TernaryInteger,
  b: TernaryInteger,
): TernaryInteger {
  if (b.value === 0n) {
    throw new Error('division by zero')
  }

  return wrap(a.value / b.value)
}

export function remainder(
  a: TernaryInteger,
  b: TernaryInteger,
): TernaryInteger {
  if (b.value === 0n) {
    throw new Error('division by zero')
  }

  return wrap(a.value % b.value)
}

// -1, 0, +1 for the sign (itself a trit)
export function sign(a: TernaryInteger): Trit {
  return a.value < 0n ? -1 : a.value > 0n ? 1 : 0
}

export function compare(a: TernaryInteger, b: TernaryInteger): Trit {
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
}

export function equals(a: TernaryInteger, b: TernaryInteger): boolean {
  return a.value === b.value
}

// encodings
export function toTernaryDigits(a: TernaryInteger): Trit[] {
  return toTrits(a.value)
}

export function fromTernaryDigits(
  trits: readonly Trit[],
): TernaryInteger {
  return wrap(fromTrits(trits))
}

export function toString(a: TernaryInteger): string {
  return tritString(a.value)
} // balanced-ternary glyphs

export function toNumber(a: TernaryInteger): number {
  return Number(a.value)
}

export function toDecimalString(a: TernaryInteger): string {
  return a.value.toString()
}
