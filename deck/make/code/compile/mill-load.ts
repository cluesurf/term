// Load one ROLE's mill from disk: follow the `load` graph out of `<role>/mine.tree` and `<role>/mint.tree`,
// strip each file's import block, and read the concatenation as one grammar. Rule names are package-global
// (test/compile/mill-grammar.ts holds them unique per role), so concatenation is the merge.
//
// This was inline in task/term/mill-coverage.ts. It moved here because three callers need the same answer: the
// coverage gate, the parity gate (mint-bridge-0001), and eventually the compiler itself. Three copies of a
// loader is how the mine and the mint start disagreeing about what the grammar says.
//
// What each file's own parse tree says (its text without the import block, its imports, its rules and their lines, the
// rule names it defines) is compile/mill-files.tree (self-hosting, 2026-10-06). This face reads the files, resolves
// each import against the mill and walks the load graph.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolvePackagePath } from '@term/make/code/resolve'
import { packageRest } from '@term/make/code/deck/resolve'
import { parse } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/narrow'
import { grammarRules, rulesDefined as definedRules, stripImports } from '@term/make/code/compile/mill-files'
import {
  readMineGrammar,
  readMintGrammar,
} from '@term/make/code/compile/mill-run'
import type {
  MineGrammar,
  MintGrammar,
} from '@term/make/code/compile/mill-run'

export type LoadedGrammar = {
  mine: MineGrammar
  mint: MintGrammar
  // the merged source of each half, so a generator can bake it in rather than re-walking the tree at build time
  mineText: string
  mintText: string
  files: string[]
  problems: string[]
  // a rule name defined in more than one reachable file. The merge is concatenation and names are role-global, so
  // the last definition WINS and the earlier ones vanish without a word. On the mine side this cost five debugging
  // rounds before `test/compile/mill-grammar.ts` started refusing it. Reported here so the mint side cannot repeat
  // it: the failure never names its own cause, it surfaces as an unrelated rule refusing input three levels away.
  collisions: { half: 'mine' | 'mint'; name: string; files: string[] }[]
}

// the grammar text WITHOUT its import block, plus the paths it imports, both read from the parse tree. There is
// ONE parser for `.tree` (note/term/one-parser.md): a regex here would strip a `load` written inside a
// `text <...>` literal and miss a path carrying an interpolation.
function readPart(
  file: string,
  problems: string[],
): { text: string; imports: string[] } {
  const part = stripImports(file, readFileSync(file, 'utf8'))

  if (part.problem !== undefined) {
    problems.push(part.problem)
  }

  return { text: part.text, imports: part.imports }
}

// resolve one `load` path against the mill: `@term/mill/<p>` by the package path rule every resolver calls
// (`resolvePackagePath`: the mill's code root, then its package root, so `@term/mill/deck/role/mine` and the older
// `@term/mill/code/deck/role/mine` both reach deck/mill/code/deck/role/mine.tree), or a `./<p>` relative to the
// importer. `millRoot` is the mill's code root, deck/mill/code, so the package is the directory above it.
export function resolveMillImport(
  millRoot: string,
  from: string,
  path: string,
): string | undefined {
  const named = packageRest(path)

  if (named.found) {
    return named.pkg === '@term/mill'
      ? resolvePackagePath({ dir: dirname(millRoot), rest: named.rest }).file
      : undefined
  }

  const nearby = /^\.\/(.+)$/.exec(path)

  if (!nearby) {
    return undefined
  }

  return [`${join(from, '..', nearby[1]!)}.tree`, join(from, '..', nearby[1]!, 'base.tree')].find(candidate =>
    existsSync(candidate),
  )
}

// One rule as a grammar FILE holds it: its name, the `like` it annotates, the form its `hook make` builds, and
// the lines it occupies. Everything a tool needs to rewrite that block in place, read from the parse tree.
//
// There is one parser for `.tree` (note/term/one-parser.md). A tool that finds `mint <name>` with a regex is a
// second reader of the grammar, and it disagrees with the first one eventually.
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
  if (!existsSync(file)) {
    return undefined
  }

  const read = grammarRules(file, readFileSync(file, 'utf8'))

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

// the rule names one grammar file defines, read off its own parse tree: a top-level group headed `mine` or
// `mint` whose second node is the rule's name
function rulesDefined(text: string, file: string, half: 'mine' | 'mint'): string[] {
  return definedRules(text, file, half)
}

function collect(
  millRoot: string,
  entry: string,
  problems: string[],
  half: 'mine' | 'mint',
  defines: Map<string, string[]>,
): { text: string; files: string[] } {
  const seen = new Set<string>()
  const parts: string[] = []
  const files: string[] = []

  const walk = (file: string): void => {
    if (seen.has(file)) {
      return
    }

    if (!existsSync(file)) {
      problems.push(`${file}: no such grammar file`)

      return
    }

    seen.add(file)
    files.push(file)

    const { text, imports } = readPart(file, problems)
    parts.push(text)

    for (const name of rulesDefined(text, file, half)) {
      const where = defines.get(name) ?? []
      where.push(file)
      defines.set(name, where)
    }

    for (const path of imports) {
      const resolved = resolveMillImport(millRoot, file, path)

      if (resolved) {
        walk(resolved)
      }
      // an unresolvable import is not a problem here: a mill loads stdlib forms (`@term/base/code/lang`) for
      // its `like` annotations, and those are not grammar files. test/compile/mill-grammar.ts is what checks
      // that every load names something real.
    }
  }

  walk(entry)

  return { text: parts.join('\n\n'), files }
}

// ONE grammar file with its load closure inlined and every import block removed: the text a generator bakes into a
// package that cannot read the mill at run time (deck/deck/task/make-grammar.ts writes the manifest and lockfile
// grammars this way). The same walk and the same resolver `loadRoleGrammar` uses, so the two cannot disagree about
// which files a grammar reaches.
export function grammarTextOf(
  millRoot: string,
  entry: string,
): { text: string; files: string[]; problems: string[] } {
  const problems: string[] = []
  const part = collect(millRoot, entry, problems, 'mine', new Map())

  return { ...part, problems }
}

export function loadRoleGrammar(
  millRoot: string,
  role: string,
): LoadedGrammar {
  const problems: string[] = []
  const mineDefines = new Map<string, string[]>()
  const mintDefines = new Map<string, string[]>()
  const minePart = collect(
    millRoot,
    join(millRoot, role, 'mine.tree'),
    problems,
    'mine',
    mineDefines,
  )
  const mintPart = collect(
    millRoot,
    join(millRoot, role, 'mint.tree'),
    problems,
    'mint',
    mintDefines,
  )
  const collisions: LoadedGrammar['collisions'] = []

  for (const [half, defines] of [
    ['mine', mineDefines],
    ['mint', mintDefines],
  ] as const) {
    for (const [name, files] of defines) {
      if (files.length > 1) {
        collisions.push({ half, name, files })
      }
    }
  }

  const read = (
    text: string,
    label: string,
  ): RootNode | undefined => {
    const parsed = parse({ file: `${role}-${label}.tree`, text })

    if (!parsed.ok) {
      problems.push(
        `${role} ${label}: ${parsed.diagnostics[0]?.message ?? 'did not parse'}`,
      )

      return undefined
    }

    return parsed.tree
  }

  const mineTree = read(minePart.text, 'mine')
  const mintTree = read(mintPart.text, 'mint')

  return {
    mine: mineTree ? readMineGrammar(mineTree) : new Map(),
    mint: mintTree ? readMintGrammar(mintTree) : new Map(),
    mineText: minePart.text,
    mintText: mintPart.text,
    files: [...minePart.files, ...mintPart.files],
    problems,
    collisions,
  }
}
