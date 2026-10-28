// The bridge: the mill executor's minted values (the language's own AST, as one form per grammar rule) into the
// compiler's `Program`. The bridge is compile/minting.tree and the seven parts it loads (self-hosting, decision 033 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0280). This face keeps the shapes
// TypeScript callers hold:
//   - a `MillResult` is a union: `program` and `twins` only when `ok` (`twins` only when there are any), `diagnostics`
//     only when not
//   - a `Grammar`'s lean rules are a `Set`, and may be absent (the parity gate loads a grammar from disk without them)
//   - the role and the lean flag may be left out
//   - every node is in node-json's declared form: a `need false` field at its default is ABSENT, as the original left
//     it (decision 034 section 2 makes the two one value, but TypeScript readers still test `x !== undefined`, among
//     them check/infer.ts's loop labels and the emitters' `label`, `index` and `nick`, which read "" as a name). The
//     port writes the default, since a Term record holds every field, so the face reads each statement and twin back
//     from its node-json text. Remove this once no TypeScript reader of the program is left.
// The original is tmp/retired/make/compile/mint-bridge-minting.ts (and -at.ts, -at-route.ts beside it, decision 042).

import type { RootNode } from '@term/make/code/parser/narrow'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Program, Twin } from '@term/make/code/compile/node'
import type { MineGrammar, MintGrammar } from '@term/make/code/compile/mill-run'
import * as port from '@term/make/code/compile/minting'
import { maskSelf } from '@term/make/code/compile/minting-reads'
import { statementJson, twinJson } from '@term/make/code/compile/node-json'

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
    return { ok: false, diagnostics: result.diagnostics as unknown as Diagnostic[] }
  }
  const program = result.program.map(one => JSON.parse(statementJson([], one as never))) as Program
  return result.twins.length > 0
    ? { ok: true, program, twins: result.twins.map(one => JSON.parse(twinJson([], one as never))) as Twin[] }
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
          lean: new Map([...(grammar.lean ?? [])].map(rule => [rule, true])),
        }
  return millResultOf(
    port.millByGrammar(
      tree as never,
      file,
      role === undefined ? { form: 'none' } : { form: 'some', value: role },
      given,
      lean === true,
    ),
  )
}
