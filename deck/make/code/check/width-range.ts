// A WIDTH IS A RANGE (note/term/plan/decisions-2026-10.md, D12). `like u8` is a `number`, and until this a value
// computed into a `u8` parameter was never checked: only a literal was (check/literals.ts). With the switch on, each
// call into a width-typed parameter owes `low <= value <= high` as a tier-0 obligation, the way a division owes a
// divisor other than zero (check/contract.ts), and the task may assume it of its parameter (check/holds.ts). Unproven,
// it is counted and named in `hold.json`, never a failed build. `to-u8` and its kin check at run time instead.
//
// Off by default, because it adds an obligation at every width site: TERM_WIDTH_RANGES=1, or `setWidthRanges`. Its own
// module, as check/strict.ts and check/seam.ts are, so the switch is module state the checker reads and a test can set.

let on = process.env.TERM_WIDTH_RANGES === '1'

// check/substitution.tree reads the switch from here (a Term module cannot import this one), when it makes a substitution
;(globalThis as { termWidthRanges?: boolean }).termWidthRanges = on

export function setWidthRanges(ranges: boolean): void {
  on = ranges
  ;(globalThis as { termWidthRanges?: boolean }).termWidthRanges = on
}

export function widthRanges(): boolean {
  return on
}

// the range of each width alias of `number`. `u64` stops at the 64-bit signed limit, the range a `number` has
export const WIDTHS: Record<string, [bigint, bigint]> = {
  u8: [0n, 255n],
  u16: [0n, 65535n],
  u32: [0n, 4294967295n],
  u64: [0n, 2n ** 63n - 1n],
  i8: [-128n, 127n],
  i16: [-32768n, 32767n],
  i32: [-2147483648n, 2147483647n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
}
