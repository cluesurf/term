// The mill: a parsed `.tree` file to the compiler's AST.
//
// THE CODE ROLE IS READ BY ITS OWN GRAMMAR, like every other dialect. `deck/mill/code/tree/code/` holds the `mine`
// and `mint` files that define the code role, `compile/mill-running.tree` runs them, and `compile/minting.tree` turns
// what they build into the compiler's nodes, grammar scopes first (compile/scope.tree), so the code grammar only ever
// sees code. This is a face over minting.tree's `mill` (self-hosting, item term-self-host-001-0280), keeping the
// TypeScript shapes compile/mint-bridge.ts names. See note/project/term/one-parser.md and
// note/project/term/mill/review/mint-bridge/readme.md for how the grammar replaced the hand-written reader.

import type { RootNode } from '@term/make/code/parser/narrow'
import { millResultOf } from '@term/make/code/compile/mint-bridge'
import type { MillResult } from '@term/make/code/compile/mint-bridge'
import * as port from '@term/make/code/compile/minting'

export type { MillResult } from '@term/make/code/compile/mint-bridge'

export function mill(
  tree: RootNode,
  file: string,
  role?: string,
  // `mark lean` on the file's role rule: a bare head is a call and a property head is a named argument.
  // See note/project/term/mill/lean.md.
  lean?: boolean,
): MillResult {
  return millResultOf(
    port.mill(tree as never, file, role === undefined ? { form: 'none' } : { form: 'some', value: role }, lean === true),
  )
}
