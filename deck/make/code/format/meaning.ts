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

import { printTree } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/tree'
import { importPathsOf, makeParseMemo } from '@term/make/code/compile/load'
import { mill } from '@term/make/code/compile/mill'

// Adjacent literal pieces of a template mean the same thing however they are split: `["<", "<", x]` and
// `["<<", x]` both render `<<` then x. The formatter re-emits a literal as one chunk where the source had two, so
// they are merged before comparing, for the same reason spans are dropped.
function mergeParts(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(mergeParts)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const out: Record<string, unknown> = {}

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    // `privateNote` is a span too, under its own name: where a `note private` line sits, for the warning
    // (check/private.ts). Formatting moves it as it moves every span, so it is position, not meaning
    if (key === 'span' || key === 'privateNote') {
      continue
    }

    if (key === 'parts' && Array.isArray(raw)) {
      const merged: unknown[] = []

      for (const part of raw) {
        const last = merged[merged.length - 1]

        if (typeof part === 'string' && typeof last === 'string') {
          merged[merged.length - 1] = last + part
        } else {
          merged.push(mergeParts(part))
        }
      }

      out[key] = merged
      continue
    }

    out[key] = mergeParts(raw)
  }

  return out
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

  // a walk's bound is held in a temporary the mill names after its POSITION (`walk-head-<line>-<column>`, in
  // compile/mint-bridge.ts), and position is exactly what formatting moves. The temporaries are renumbered in order
  // of first appearance, so a consistent renaming compares equal and a different structure still does not
  const temporaries = new Map<string, string>()
  // a literal past 2^53 is milled as a bigint (check/literals.ts), which JSON.stringify refuses: written with an `n`,
  // so `9007199254740993` and `9007199254740992` still compare different
  const bigint = (_key: string, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value)

  return JSON.stringify(mergeParts(built.program), bigint).replace(/walk-head-\d+-\d+/g, name => {
    if (!temporaries.has(name)) {
      temporaries.set(name, `walk-head-${temporaries.size}`)
    }

    return temporaries.get(name)!
  })
}

// the `load` / `bear` paths a text names, through the compiler's own reader so this cannot disagree with the build
export function importsOf(file: string, text: string): string {
  return importPathsOf({ file, text }, makeParseMemo()).join('|')
}

// a tree's import paths, read off its canonical print
export function treeImportsOf(tree: RootNode, file: string): string {
  return importsOf(file, printTree(tree))
}
