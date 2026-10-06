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
// The merge and the JSON are Term, format/meanings.tree (self-hosting, 2026-10-06). This face mills, and converts the
// program into the ordered JSON value Term reads: a literal past 2^53 is milled as a bigint (check/literals.ts), which
// JSON.stringify refuses, so it is written with an `n`, and `9007199254740993` and `9007199254740992` still compare
// different. A walk's temporaries need no rewriting: the mill names them by the walk's order in the file
// (compile/mint-bridge.ts, `walks`), which formatting never moves.

import { printTree } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/narrow'
import { importPathsOf, makeParseMemo } from '@term/make/code/compile/load'
import { mill } from '@term/make/code/compile/mill'
import * as meanings from '@term/make/code/format/meanings'
import type { RollValue } from '@term/make/code/compile/rolling'

// a plain value as the ordered JSON value: keys in their order, `undefined` kept as a key JSON leaves out
function toValue(value: unknown): RollValue {
  if (value === undefined) {
    return { form: 'no-value' }
  }

  if (value === null) {
    return { form: 'null-value' }
  }

  if (typeof value === 'bigint') {
    return { form: 'text-value', value: `${value}n` }
  }

  if (typeof value === 'string') {
    return { form: 'text-value', value }
  }

  if (typeof value === 'number') {
    return { form: 'number-value', value }
  }

  if (typeof value === 'boolean') {
    return { form: 'flag-value', value }
  }

  if (Array.isArray(value)) {
    return { form: 'item-values', values: value.map(toValue) }
  }

  if (typeof value === 'object') {
    return {
      form: 'pair-values',
      pairs: Object.entries(value as Record<string, unknown>).map(([key, inner]) => ({ key, value: toValue(inner) })),
    }
  }

  // a function or a symbol, which JSON leaves out as it leaves out `undefined`
  return { form: 'no-value' }
}

// The mill's Program for a tree, spans dropped and template pieces merged, or undefined when it does not mill.
// `lean` is the file's `mark lean`: a lean file milled as longhand is a different program, and `f()` against a bare
// `f` is a difference only the lean reading shows in full.
export function programOf(tree: RootNode, file: string, lean = false): string | undefined {
  let built

  try {
    built = mill(tree, file, undefined, lean)
  } catch {
    return undefined
  }

  if (!built.ok) {
    return undefined
  }

  return meanings.meaningOf(toValue(built.program))
}

// the `load` / `bear` paths a text names, through the compiler's own reader so this cannot disagree with the build
export function importsOf(file: string, text: string): string {
  return importPathsOf({ file, text }, makeParseMemo()).join('|')
}

// a tree's import paths, read off its canonical print
export function treeImportsOf(tree: RootNode, file: string): string {
  return importsOf(file, printTree(tree))
}
