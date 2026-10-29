// What a `.tree` file MEANS, as one comparable string: the mill's Program with spans dropped and template pieces
// merged, and the import paths beside it. The formatter accepts a layout when this is identical before and after,
// and test/format/sweep.ts holds the whole repository to the same comparison, so the two cannot disagree about
// what "the same program" is.
//
// Compared at the MILL level, not on the parse tree, on purpose: `make list, 3, 1` and `make list(3, 1)` are
// different trees the mill reads as the same list, and moving between such forms is what a formatter may do.
//
// The import paths are compared SEPARATELY because a `load` never becomes a mill Statement: the loader resolves it,
// so the Program is blind to it. That blindness once hid the formatter turning every `{platform}` import into
// `{{platform}}`.
//
// The whole of it is Term: format/meanings.tree (the merge and the JSON) and format/milled-meaning.tree (the mill, the
// walk of its answer, the import paths), item term-self-host-001-0087. This face hands back an absent meaning as
// `undefined`, the shape its callers test.

import type { RootNode } from '@term/make/code/parser/narrow'
import * as port from '@term/make/code/format/milled-meaning'

export { importsOf } from '@term/make/code/format/milled-meaning'

// The mill's Program for a tree, spans dropped and template pieces merged, or undefined when it does not mill.
// `lean` is the file's `mark lean`: a lean file milled as longhand is a different program, and `f()` against a bare
// `f` is a difference only the lean reading shows in full.
export function programOf(
  tree: RootNode,
  file: string,
  lean = false,
): string | undefined {
  const meaning = port.programOf(tree as never, file, lean)

  return meaning.form === 'some' ? meaning.value : undefined
}

// a tree's import paths, read off its canonical print
export function treeImportsOf(tree: RootNode, file: string): string {
  return port.treeImportsOf(tree as never, file)
}
