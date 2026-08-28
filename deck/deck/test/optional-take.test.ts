// Regression tests for omitting a `need false` parameter at a call.
//
// The inference pass has always accepted the shorter call: it checks arity as
// a RANGE, from the required count up to the declared count. The kernel does
// not see parameters, only an arrow chain, and an application with fewer
// arguments than the chain has binders is a PARTIAL APPLICATION.
//
// So a call that left out an optional parameter came back typed
// `(many Boolean) -> String` where a `String` was wanted, and the mismatch
// was reported wherever the value was used rather than at the call. `need
// false` reads as though the parameter may be left out, which is exactly what
// it means, so nothing about the message pointed at the cause.

import { describe, it, expect } from 'vitest'
import { compile } from '@term/make/code/compile/compile'

const OMITTED = `task greet
  take name, like text
  take loud, like boolean
    need false
  like text
  send back
    read name

task use
  like text
  send back
    call greet
      bind name, text <hi>
`

const GIVEN = `task greet
  take name, like text
  take loud, like boolean
    need false
  like text
  send back
    read name

task use
  like text
  send back
    call greet
      bind name, text <hi>
      bind loud, true
`

const TOO_FEW = `task greet
  take name, like text
  take loud, like boolean
  like text
  send back
    read name

task use
  like text
  send back
    call greet
      bind name, text <hi>
`

describe('an omitted `need false` parameter', () => {
  it('compiles rather than partially applying', () => {
    const result = compile({ file: 'opt.tree', text: OMITTED })

    expect(result.ok).toBe(true)
  })

  it('emits a real call, not a curried one', () => {
    const result = compile({ file: 'opt.tree', text: OMITTED })
    const out = result.ok ? result.typescript : ''

    expect(out).toContain('greet("hi")')
  })

  it('still compiles when the parameter IS given', () => {
    expect(compile({ file: 'opt.tree', text: GIVEN }).ok).toBe(true)
  })
})

describe('a genuinely missing required parameter', () => {
  it('is still an error', () => {
    // The point of the fix is to stop a LEGAL call being rejected. It must
    // not start accepting an illegal one.
    expect(compile({ file: 'few.tree', text: TOO_FEW }).ok).toBe(false)
  })
})
