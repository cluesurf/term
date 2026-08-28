// Regression tests for text literals that are never closed.
//
// Inside `text <...>` the angles BALANCE, so a generic written as content
// (`Hmac<Sha256>`) survives. The cost is that one unescaped `<` -- a `s < 60`
// in a native body -- opens a bracket that never closes, and the literal eats
// the rest of the file.
//
// What that used to look like: the file compiled "fine", every name declared
// after the bad line silently vanished, and the build reported undefined
// names in a dozen OTHER files that imported them. Nothing pointed at the
// line that did it. It cost an afternoon at least once.

import { describe, it, expect } from 'vitest'
import { compile } from '@term/make/code/compile/compile'

const OPEN = `bind bad
  take s, like number
  like boolean
  case node
    text <(function () { return s < 60 })()>

task after-it
  like text
  send back
    text <still here>
`

const CLOSED = `bind good
  take s, like number
  like boolean
  case node
    text <(function () { return s \\< 60 })()>

task after-it
  like text
  send back
    text <still here>
`

const BALANCED = `bind generic
  like text
  case node
    text <new Map<string, number>().size>
`

describe('an unclosed text literal', () => {
  it('is an error rather than a file that quietly ends early', () => {
    const result = compile({ file: 'bad.tree', text: OPEN })

    expect(result.ok).toBe(false)
  })

  it('points at the literal that opened, not at some later file', () => {
    const result = compile({ file: 'bad.tree', text: OPEN })
    const first = result.ok ? undefined : result.diagnostics[0]

    // Spans are 0-indexed, so line 4 is the fifth line, `text <...>`.
    expect(first?.span?.start.line).toBe(4)
  })

  it('says what to do about it', () => {
    const result = compile({ file: 'bad.tree', text: OPEN })
    const hint = result.ok ? '' : (result.diagnostics[0]?.hint ?? '')

    expect(hint).toContain('never closed')
    expect(hint).toContain('\\<')
  })
})

describe('a text literal that is closed', () => {
  it('compiles when the stray angle is escaped', () => {
    expect(compile({ file: 'good.tree', text: CLOSED }).ok).toBe(true)
  })

  it('still allows balanced angles as content, which is why they balance', () => {
    expect(compile({ file: 'generic.tree', text: BALANCED }).ok).toBe(true)
  })
})
