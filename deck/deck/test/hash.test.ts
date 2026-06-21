import { describe, it, expect } from 'vitest'
import { hashBuffer, hashText, verifyHash } from '../code/hash'

describe('hashBuffer', () => {
  it('hashes a buffer consistently', async () => {
    const data = Buffer.from('hello world')
    const hash1 = await hashBuffer({ data })
    const hash2 = await hashBuffer({ data })
    expect(hash1).toBe(hash2)
    expect(hash1.length).toBe(128) // SHA-512 hex = 128 chars
  })

  it('produces different hashes for different data', async () => {
    const hash1 = await hashBuffer({ data: Buffer.from('hello') })
    const hash2 = await hashBuffer({ data: Buffer.from('world') })
    expect(hash1).not.toBe(hash2)
  })
})

describe('hashText', () => {
  it('hashes text consistently', async () => {
    const hash1 = await hashText({ text: 'hello' })
    const hash2 = await hashText({ text: 'hello' })
    expect(hash1).toBe(hash2)
  })
})

describe('verifyHash', () => {
  it('returns true for matching hash', async () => {
    const data = Buffer.from('test data')
    const hash = await hashBuffer({ data })
    expect(verifyHash({ data, expected: hash })).toBe(true)
  })

  it('returns false for non-matching hash', () => {
    const data = Buffer.from('test data')
    expect(verifyHash({ data, expected: 'badhash' })).toBe(false)
  })
})
