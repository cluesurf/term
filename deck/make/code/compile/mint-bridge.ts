// The bridge: the mill executor's minted values (the language's own AST, as one form per grammar rule) into the
// compiler's `Program`. The bridge is compile/minting.tree and the seven parts it loads (self-hosting, decision 033 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0280). This face keeps the shapes
// TypeScript callers hold:
//   - a `MillResult` is a union: `program` and `twins` only when `ok` (`twins` only when there are any), `diagnostics`
//     only when not
//   - a `Grammar`'s lean rules are a `Set`, and may be absent (the parity gate loads a grammar from disk without them)
//   - the role and the lean flag may be left out
// Each statement and twin is the port's own record, every field written, a `need false` field at its default
// included: decision 034 section 2 makes an absent field and its default one value, and since the checker and the
// emitters are Term no reader tells them apart (decision 046 section 2, decision 060, item 0318).
// The original is tmp/retired/make/compile/mint-bridge-minting.ts (and -at.ts, -at-route.ts beside it, decision 042).

import type { RootNode } from '@term/make/code/parser/narrow'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Program, Twin } from '@term/make/code/compile/node'
import type {
  MineGrammar,
  MintGrammar,
} from '@term/make/code/compile/mill-run'
import * as port from '@term/make/code/compile/minting'
import { maskSelf } from '@term/make/code/compile/minting-reads'

export type MillResult =
  // `twins` sit beside the program and never in it (node.ts, `Twin`), so a reader that ignores them is correct
  | { ok: true; program: Program; twins?: Twin[] }
  | { ok: false; diagnostics: Diagnostic[] }

// the generic a mask's tasks take for the type that wears it
export const MASK_SELF: string = maskSelf()

export type Grammar = {
  mine: MineGrammar
  mint: MintGrammar
  lean?: Set<string>
}

// the port's answer in the face's shape
export function millResultOf(result: port.MillResult): MillResult {
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics as unknown as Diagnostic[],
    }
  }

  const program = result.program as unknown as Program

  return result.twins.length > 0
    ? { ok: true, program, twins: result.twins as unknown as Twin[] }
    : { ok: true, program }
}

export function millByGrammar(
  tree: RootNode,
  file: string,
  // the file's ROLE, from the project's role.tree. `site` and `call` decide what a `hook` is
  role?: string,
  // the grammar to read with. Omitted, the baked one is used, which is what the compiler does
  grammar?: Grammar,
  // `mark lean` on the file's role rule
  lean?: boolean,
): MillResult {
  const given: port.MintGrammar =
    grammar === undefined
      ? port.bakedGrammar()
      : {
          mine: grammar.mine as never,
          mint: grammar.mint as never,
          lean: new Map(
            [...(grammar.lean ?? [])].map(rule => [rule, true]),
          ),
        }

  return millResultOf(
    port.millByGrammar(
      tree as never,
      file,
      role === undefined
        ? { form: 'none' }
        : { form: 'some', value: role },
      given,
      lean === true,
    ),
  )
}
