// Regression tests for `fork case` (match) lowering in the TypeScript
// backend. A match compiles three different ways depending on what it
// matches, and getting the wrong one is a SILENT miss (every branch
// fails, no error), which is how the zone CLI shipped broken:
//
//   - an ENUM value  -> `subject.form === "variant"`
//   - a STRING value -> `subject === "literal"`
//   - a BOOLEAN      -> `if (subject)` / `if (!subject)`
//
// The string and boolean cases both used to emit `.form === ...`, which
// reads `undefined` off a primitive and misses every arm.

import { describe, it, expect } from 'vitest'
import { compile } from '@term/make/code/compile/compile'

function emit(source: string): string {
  const result = compile({ file: 'match.tree', text: source })

  if (!result.ok) {
    throw new Error(
      result.diagnostics.map(d => d.message).join('\n') ||
        'compile failed',
    )
  }

  return result.typescript
}

describe('match lowering', () => {
  it('matches a STRING value by equality, not by .form', () => {
    const ts = emit(`task classify
  take kind, like text
  like text
  fork case, read kind
    case keychain
      send back
        text <mac>
    case secret
      send back
        text <linux>
  send back
    text <none>
`)

    expect(ts).toContain('kind === "keychain"')
    expect(ts).toContain('kind === "secret"')
    expect(ts).not.toContain('kind.form')
  })

  it('matches a BOOLEAN by truthiness, not by .form', () => {
    const ts = emit(`task label
  take flag, like boolean
  like text
  fork case, read flag
    case true
      send back
        text <on>
    case false
      send back
        text <off>
`)

    // both arms covered, so the chain closes with a plain `else`
    // (exhaustive control flow) rather than a second `if`
    expect(ts).not.toContain('flag.form')
    expect(ts).toContain('if (flag)')
    expect(ts).toContain('} else {')
  })

  it('matches an ENUM value by its .form discriminant', () => {
    const ts = emit(`form box
  case full, like text
  case void

task open
  take b, like box
  like text
  fork case, read b
    case full, link text
      send back
        read text
    case void
      send back
        text <empty>
`)

    expect(ts).toContain('.form === "full"')
    expect(ts).toContain('.form === "void"')
  })

  it('parenthesizes a compound subject before .form', () => {
    // a match on an ADT-returning call whose subject is a binary
    // expression must wrap it, or `.form` binds to the last operand
    const ts = emit(`form flag
  case yes
  case no

task pick
  take n, like number
  like flag
  fork test
    hook test
      call is-above
        read n
        code 0
    hook hold
      send back
        make yes
    hook miss
      send back
        make no
`)

    // sanity: it compiles and yields the two constructors
    expect(ts).toContain('form: "yes"')
    expect(ts).toContain('form: "no"')
  })
})
