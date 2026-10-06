// F4, the first text fact (note/term/codegen/shared.md): which text expressions are ASCII, so a code-point read of one
// is a direct index on every backend. The analysis is Term, ir/facts/ascii.tree (self-hosting, 2026-10-06), and its
// header says what is ASCII. This face makes the set the emitters ask of by identity, which Term cannot hold: the port
// answers the proven nodes themselves.

import type { Program } from '@term/make/code/compile/node'
import { asciiTexts as asciiNodes } from '@term/make/code/ir/facts/ascii'

export function asciiTexts(program: Program): WeakSet<object> {
  return new WeakSet<object>(asciiNodes(program))
}
