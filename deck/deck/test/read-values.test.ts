// A line can carry more than one `<...>`, and all of them survive.
//
// `time <made>, <toss>` is a range. The parser keeps both texts; the
// flattening to a Form used to assign `form.value` twice, so the LAST won
// and the first vanished. That reads as a value nobody wrote rather than as
// an error, and it cost a file format: `zone`'s cache header was split into
// two lines to work around a limitation that was never in the language.

import { describe, it, expect } from 'vitest'
import { readTree } from '@/read'

function forms(text: string) {
  const got = readTree({ file: 'x.tree', text })

  if (!got.ok) {
    throw new Error(got.diagnostics.map(d => d.message).join('\n'))
  }

  return got.forms
}

describe('a line with several values', () => {
  it('keeps every one, in order', () => {
    const [one] = forms('time <made>, <toss>\n')

    expect(one?.values).toEqual(['made', 'toss'])
  })

  it('still reports the first as `value`, so existing readers are unchanged', () => {
    const [one] = forms('time <made>, <toss>\n')

    expect(one?.value).toBe('made')
  })

  it('handles a single value the same way', () => {
    const [one] = forms('code <aes-256-gcm>\n')

    expect(one?.value).toBe('aes-256-gcm')
    expect(one?.values).toEqual(['aes-256-gcm'])
  })

  it('gives no values to a line that carries none', () => {
    const [one] = forms('code aes-256-gcm\n')

    expect(one?.value).toBeUndefined()
    expect(one?.values).toEqual([])
  })

  it('keeps numbers too', () => {
    const [one] = forms('span 1, 2\n')

    expect(one?.values).toEqual(['1', '2'])
  })
})
