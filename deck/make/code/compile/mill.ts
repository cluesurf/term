// The mill: a parsed `.tree` file to the compiler's AST.
//
// THE CODE ROLE IS READ BY ITS OWN GRAMMAR, like every other dialect.
//
// `deck/mill/code/code/` holds the `mine` and `mint` files that define the code role. `compile/mill-run.ts` runs
// them and `compile/mint-bridge.ts` turns what they build into the compiler's nodes. Nothing here reads `.tree`
// syntax by hand any more, which is the rule every other dialect in the tree already obeyed. See
// note/term/one-parser.md.
//
// WHAT USED TO BE HERE. `compile/mill-legacy.ts` is the hand-written reader, 5,366 lines that lowered a parse
// tree by hand. It came off the compile path on 2026-09-01 (mint-bridge-0004), and nothing the compiler ships
// imports it. It stays on disk as the reference half of the historical parity gate, which runs it only under
// `pnpm term:mint-parity --reference`. Do not edit it and do not import it: a second implementation of a grammar
// disagrees with the grammar eventually, and the disagreement is silent.
//
// HOW THE SWITCH WAS MADE, because the first attempt failed and the reason is worth keeping. It flipped once, on
// 2026-08-31, on full byte parity over every `.tree` file in all twelve packages, and `pnpm term:test` went from
// 247 pass / 0 fail to 140 / 107. The pool was wrong: the compiler does not only mill files, it mills source
// STRINGS the suites and tools write inline, and those use constructs no file in the tree contains. A corpus is
// not a language. So the measurement moved here, where every caller passes through, behind a flag that ran the
// switch without making it (`TERM_MILL_GRAMMAR=1 pnpm term:test`), and the 107 failures were worked down one at
// a time to zero before the line moved. The account is in note/term/mint-bridge/readme.md.

import type { RootNode } from '@term/make/code/parser/tree'
import { millByGrammar } from '@term/make/code/compile/mint-bridge'
import type { MillResult } from '@term/make/code/compile/mint-bridge'

export type { MillResult } from '@term/make/code/compile/mint-bridge'

// the surface vocabulary, re-exported from its own module so the readers that import it from here keep working
export {
  BINARY_BUILTIN,
  UNARY_BUILTIN,
  HALT_WORDS,
} from '@term/make/code/compile/surface'

export function mill(
  tree: RootNode,
  file: string,
  role?: string,
): MillResult {
  return millByGrammar(tree, file, role)
}
