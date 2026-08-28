// Regression tests for a form's type parameters reaching the emitted
// TypeScript.
//
// `form maybe / head t` declares a parameter. The emitter used to drop it and
// produce
//
//   export type Maybe =
//     | { form: "some"; value: T }
//
// where `T` is never declared. Nothing caught it, because `term boot` strips
// types rather than checking them, so the annotation only had to parse. The
// real cost was that a head could never constrain anything: a provider native
// annotated `like maybe / head text` and one returning some other shape
// looked identical to the compiler.

import { describe, it, expect } from 'vitest'
import { compile } from '@term/make/code/compile/compile'

const MAYBE = `form maybe
  head t
  case some
    link value, like t
  case none
`

const BOX = `form box
  head t
  link item, like t
`

function emit(source: string): string {
  const result = compile({ file: 'form.tree', text: source })

  if (!result.ok) {
    throw new Error(result.diagnostics.map(d => d.message).join('\n'))
  }

  return result.typescript
}

describe("a form's heads", () => {
  it('are declared on the union it emits', () => {
    expect(emit(MAYBE)).toContain('type Maybe<T')
  })

  it('are declared on the interface it emits', () => {
    expect(emit(BOX)).toContain('interface Box<T')
  })

  it('carry a default, so a reference with no arguments still compiles', () => {
    expect(emit(MAYBE)).toContain('= unknown')
  })

  it('never leave the parameter used but undeclared', () => {
    const out = emit(MAYBE)
    const alias = out.slice(out.indexOf('type Maybe'))

    // the body uses T, so the head must be there to bind it
    expect(alias).toContain('value: T')
    expect(alias.slice(0, alias.indexOf('='))).toContain('T')
  })
})
