import { describe, it, expect } from 'vitest'
import { decimal } from '@term/base/code/base/make'
import { compareValues } from '@term/base/code/query/compare'

// Decimal ordering must be EXACT, not via Number(): high-precision decimals that
// differ only in a far digit must not collapse to equal, or a range/order query
// silently drops one.
describe('decimal comparison precision', () => {
  it('distinguishes 20-digit decimals differing in the last digit', () => {
    const a = decimal('1.00000000000000000001')
    const b = decimal('1.00000000000000000002')
    expect(compareValues(a, b)).toBe(-1)
    expect(compareValues(b, a)).toBe(1)
    // Number() would collapse both to 1 and return 0
  })

  it('orders large-magnitude decimals exactly', () => {
    const a = decimal('9007199254740993') // 2^53 + 1, unrepresentable as a double
    const b = decimal('9007199254740992') // 2^53
    expect(compareValues(a, b)).toBe(1)
  })

  it('treats trailing-zero scales as numerically equal', () => {
    expect(compareValues(decimal('5.00'), decimal('5.0'))).toBe(0)
    expect(compareValues(decimal('5.0'), decimal('5'))).toBe(0)
  })

  it('orders negatives correctly', () => {
    expect(compareValues(decimal('-2.5'), decimal('-2.4'))).toBe(-1)
    expect(compareValues(decimal('-0.1'), decimal('0.1'))).toBe(-1)
  })
})
