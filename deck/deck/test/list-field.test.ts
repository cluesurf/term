// Regression tests for the emitted type of a form's list field.
//
// `link need, list need` is the field shorthand for a list: the element type
// follows `list` directly, rather than inside an inner `like` the way
// `like list / like t` does. Only the second spelling was handled, so the
// first left the field's type UNKNOWN and it emitted as `number` -- the
// fallback tsType uses for an unresolved type.
//
// The runtime was always right. It was the emitted TypeScript that lied,
// which meant no emitted interface holding a list could be trusted, and
// every one of zone's forms holds several.

import { describe, it, expect } from 'vitest'
import { compile } from '@term/make/code/compile/compile'

const SOURCE = `form need
  link name, like text

form spot
  link name, like text
  link need, list need
  link cast, list text
  link deep, list spot
`

function emit(source: string): string {
  const result = compile({ file: 'form.tree', text: source })

  if (!result.ok) {
    throw new Error(result.diagnostics.map(d => d.message).join('\n'))
  }

  return result.typescript
}

describe('a list field', () => {
  const out = emit(SOURCE)

  it('emits an array of the named form', () => {
    expect(out).toContain('need: Need[]')
  })

  it('emits an array of a primitive element', () => {
    expect(out).toContain('cast: string[]')
  })

  it('handles a list of the form being declared', () => {
    expect(out).toContain('deep: Spot[]')
  })

  it('never falls back to number', () => {
    expect(out).not.toContain('need: number')
    expect(out).not.toContain('cast: number')
    expect(out).not.toContain('deep: number')
  })
})
