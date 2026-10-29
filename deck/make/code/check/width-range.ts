// A WIDTH IS A RANGE (note/project/term/decisions-2026-10/decisions-2026-10.md, D12). `like u8` is a `number`, and until this a value
// computed into a `u8` parameter was never checked: only a literal was (check/literals.ts). With the switch on, each
// call into a width-typed parameter owes `low <= value <= high` as a tier-0 obligation, the way a division owes a
// divisor other than zero (check/contract.ts), and the task may assume it of its parameter (check/holds.ts). Unproven,
// it is counted and named in `hold.json`, never a failed build. `to-u8` and its kin check at run time instead.
//
// Off by default, because it adds an obligation at every width site: TERM_WIDTH_RANGES=1, or `setWidthRanges`.
//
// A face over check/checker-switches.tree (item term-self-host-001-0261): the switch is the `widths` field of the one
// `checker-switches` instance check/strict.ts holds, and the limits are that module's `width-limits`.

import { checkerSwitches } from '@term/make/code/check/strict'
import { widthLimits } from '@term/make/code/check/checker-switches'

// check/substitution.tree reads the switch through `globalThis.termWidthRanges` (a Term module cannot import this
// one), which check/strict.ts writes when it makes the instance and this writes on every set. It goes when
// substitution.tree's `width-switch` bind reads the record (item 0248)
export function setWidthRanges(ranges: boolean): void {
  checkerSwitches.widths = ranges
  ;(globalThis as { termWidthRanges?: boolean }).termWidthRanges =
    ranges
}

export function widthRanges(): boolean {
  return checkerSwitches.widths
}

// the range of each width alias of `number`. `u64` stops at the 64-bit signed limit, the range a `number` has
export const WIDTHS: Record<string, [bigint, bigint]> =
  Object.fromEntries(
    widthLimits().map(limit => [
      limit.width,
      [BigInt(limit.low), BigInt(limit.high)],
    ]),
  )
