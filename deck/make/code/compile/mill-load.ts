// Load one ROLE's mill from disk: follow the `load` graph out of `<role>/mine.tree` and `<role>/mint.tree`, strip each
// file's import block, and read the concatenation as one grammar. Rule names are package-global (test/compile/
// mill-grammar.ts holds them unique per role), so concatenation is the merge. Three callers need the same answer: the
// coverage gate, the parity gate (mint-bridge-0001) and the grammar bundler, and three copies of a loader is how the
// mine and the mint start disagreeing about what the grammar says.
//
// What each file's parse tree says is compile/mill-files.tree, and the reads, the resolving of each import and the walk
// are compile/mill-files-disk.tree (item 0076), through @term/base/file/blocking. This face keeps the shapes its callers
// hold and hands the port resolve.ts's code root, whose cache every resolver shares.

import { codeRootOf } from '@term/make/code/resolve'
import * as disk from '@term/make/code/compile/mill-files-disk'
import type { MineGrammar, MintGrammar } from '@term/make/code/compile/mill-run'

export type LoadedGrammar = {
  mine: MineGrammar
  mint: MintGrammar
  // the merged source of each half, so a generator can bake it in rather than re-walking the tree at build time
  mineText: string
  mintText: string
  files: string[]
  problems: string[]
  // a rule name defined in more than one reachable file. The merge is concatenation and names are role-global, so the
  // last definition WINS and the earlier ones vanish without a word: the failure never names its own cause, it surfaces
  // as an unrelated rule refusing input three levels away
  collisions: { half: 'mine' | 'mint'; name: string; files: string[] }[]
}

// resolve one `load` path against the mill: `@term/mill/<p>` by the package path rule every resolver calls (the mill's
// code root, then its package root), or a `./<p>` relative to the importer. `millRoot` is where the dialects are,
// deck/mill/code/tree since 2026-10-06, so the package is the nearest folder above it holding a `deck.tree`
export function resolveMillImport(millRoot: string, from: string, path: string): string | undefined {
  const found = disk.resolveMillImport(millRoot, from, path, codeRootOf)
  return found.form === 'some' ? found.value : undefined
}

// One rule as a grammar FILE holds it: its name, the `like` it annotates, the form its `hook make` builds, and the lines
// it occupies, read from the parse tree (note/project/term/one-parser.md). Everything a tool needs to rewrite that
// block in place
export type GrammarRule = {
  half: 'mine' | 'mint'
  name: string
  like?: string
  makeForm?: string
  // 0-based, inclusive of the head line, exclusive of the end
  from: number
  to: number
}

export type GrammarFile = {
  file: string
  text: string
  rules: GrammarRule[]
  // the lines occupied by a `load` of another grammar file, so a regenerated block replaces them exactly
  grammarLoadLines: Set<number>
}

export function readGrammarFile(file: string): GrammarFile | undefined {
  const read = disk.grammarFileOnDisk(file)

  if (read.form === 'none') {
    return undefined
  }

  return {
    file: read.value.file,
    text: read.value.text,
    rules: read.value.rules.map(rule => ({
      half: rule.half as 'mine' | 'mint',
      name: rule.name,
      like: rule.like,
      makeForm: rule.makeForm,
      from: rule.from,
      to: rule.to,
    })),
    grammarLoadLines: new Set(read.value.loadLines),
  }
}

// ONE grammar file with its load closure inlined and every import block removed: the text a generator bakes into a
// package that cannot read the mill at run time (deck/deck/task/make-grammar.ts). The same walk and resolver
// `loadRoleGrammar` uses, so the two cannot disagree about which files a grammar reaches
export function grammarTextOf(millRoot: string, entry: string): { text: string; files: string[]; problems: string[] } {
  return disk.grammarTextOf(millRoot, entry, codeRootOf)
}

export function loadRoleGrammar(millRoot: string, role: string): LoadedGrammar {
  return disk.loadRoleGrammar(millRoot, role, codeRootOf) as LoadedGrammar
}
