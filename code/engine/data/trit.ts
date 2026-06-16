// The trit, the base-3 digit, in BALANCED ternary: each digit is -1, 0, or +1. Balanced ternary is the radix the
// hyperbolic computer stores numbers in (radix-economical, the vibe-native alphabet, and negation is free). This
// file is the number core: convert between an exact integer (bigint) and its balanced-ternary digits, and the
// digit-level primitives every other type builds on.
//
// Arithmetic on the VALUE is exact bigint (optimal), the trit array is the encoding for display, storage, and the
// associative words. Digits are stored LEAST significant first, the natural order for carry ripple.

export type Trit = -1 | 0 | 1

// the printable form, '-' for -1, '0' for 0, '+' for +1 (most significant first, like we write numbers)
const GLYPH: Record<string, string> = { '-1': '-', '0': '0', '1': '+' }

// the balanced-ternary digits of an integer, least significant first. The empty value 0 is a single 0 trit.
export function toTrits(value: bigint): Trit[] {
  if (value === 0n) return [0]
  const trits: Trit[] = []
  let v = value
  while (v !== 0n) {
    // remainder in {0,1,2}, then shift 2 down to -1 so digits stay balanced
    let r = ((v % 3n) + 3n) % 3n
    if (r === 2n) { trits.push(-1); v = (v + 1n) / 3n }
    else { trits.push(Number(r) as Trit); v = (v - r) / 3n }
  }
  return trits
}

// the integer value of a balanced-ternary digit array (least significant first)
export function fromTrits(trits: readonly Trit[]): bigint {
  let value = 0n
  let power = 1n
  for (const t of trits) {
    value += BigInt(t) * power
    power *= 3n
  }
  return value
}

// negate, just flip every digit's sign. This is the gift of balanced ternary: no two's complement, no sign bit.
export function negateTrits(trits: readonly Trit[]): Trit[] {
  return trits.map((t) => (-t) as Trit)
}

// the printable balanced-ternary string, most significant first (e.g. 5 -> "+--", since 5 = 9 - 3 - 1)
export function tritString(value: bigint): string {
  const trits = toTrits(value)
  return trits
    .map((t) => GLYPH[String(t)]!)
    .reverse()
    .join('')
}

// parse a balanced-ternary string (most significant first, glyphs '+', '0', '-') back to an integer
export function fromTritString(text: string): bigint {
  const trits: Trit[] = []
  for (const ch of text) {
    if (ch === '+') trits.push(1)
    else if (ch === '-') trits.push(-1)
    else if (ch === '0') trits.push(0)
    else throw new Error(`bad balanced-ternary glyph "${ch}"`)
  }
  trits.reverse() // string is MSB-first, the array is LSB-first
  return fromTrits(trits)
}

// the number of trits needed to hold a value (its balanced-ternary length), at least 1
export function tritLength(value: bigint): number {
  return toTrits(value).length
}

// the inclusive range of a fixed-width balanced-ternary word of `n` trits: [-(3^n - 1)/2, +(3^n - 1)/2]
export function tritWordRange(n: number): { min: bigint; max: bigint } {
  const half = (3n ** BigInt(n) - 1n) / 2n
  return { min: -half, max: half }
}

// pad or check a digit array to a fixed width (used when storing a fixed-resolution word)
export function toFixedTrits(value: bigint, width: number): Trit[] {
  const trits = toTrits(value)
  if (trits.length > width) throw new Error(`value ${value} needs ${trits.length} trits, exceeds width ${width}`)
  while (trits.length < width) trits.push(0)
  return trits
}
