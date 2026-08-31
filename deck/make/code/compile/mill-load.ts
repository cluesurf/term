// Load one ROLE's mill from disk: follow the `load` graph out of `<role>/mine.tree` and `<role>/mint.tree`,
// strip each file's import block, and read the concatenation as one grammar. Rule names are package-global
// (test/compile/mill-grammar.ts holds them unique per role), so concatenation is the merge.
//
// This was inline in task/term/mill-coverage.ts. It moved here because three callers need the same answer: the
// coverage gate, the parity gate (mint-bridge-0001), and eventually the compiler itself. Three copies of a
// loader is how the mine and the mint start disagreeing about what the grammar says.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/tree'
import {
  readMineGrammar,
  readMintGrammar,
  spanOfNode,
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
  const text = readFileSync(file, 'utf8')
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    problems.push(
      `${file}: ${parsed.diagnostics[0]?.message ?? 'did not parse'}`,
    )

    return { text, imports: [] }
  }

  const lines = text.split('\n')
  const drop = new Set<number>()
  const imports: string[] = []

  for (const group of parsed.tree.nodes) {
    const first = group.nodes[0]
    const name = first?.kind === 'name' ? renderHead(first) : undefined

    if (name !== 'load') {
      continue
    }

    // every line this statement spans, so the import block is removed exactly rather than by pattern
    const span = spanOfNode(group)
    const last = spanOfNode(group.nodes[group.nodes.length - 1]!)
    const from = span?.start.line ?? 0
    const to = last?.end.line ?? from

    for (let i = from; i <= to; i++) {
      drop.add(i)
    }

    const target = group.nodes[1]

    if (target?.kind === 'group') {
      const head = target.nodes[0]

      if (head?.kind === 'name') {
        imports.push(renderHead(head))
      }
    }
  }

  return {
    text: lines.filter((_, i) => !drop.has(i)).join('\n'),
    imports,
  }
}

// resolve one `load` path against the mill root: `@term/mill/code/<p>` or a `./<p>` relative to the importer
function resolveImport(
  millRoot: string,
  from: string,
  path: string,
): string | undefined {
  const inMill = /^@term\/mill\/code\/(.+)$/.exec(path)
  const nearby = /^\.\/(.+)$/.exec(path)
  const bases = inMill
    ? [
        join(millRoot, `${inMill[1]!}.tree`),
        join(millRoot, inMill[1]!, 'base.tree'),
      ]
    : nearby
      ? [
          `${join(from, '..', nearby[1]!)}.tree`,
          join(from, '..', nearby[1]!, 'base.tree'),
        ]
      : []

  return bases.find(candidate => existsSync(candidate))
}

// the rule names one grammar file defines, read off its own parse tree: a top-level group headed `mine` or
// `mint` whose second node is the rule's name
function rulesDefined(text: string, file: string, half: 'mine' | 'mint'): string[] {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return []
  }

  const names: string[] = []

  for (const group of parsed.tree.nodes) {
    const head = group.nodes[0]

    if (head?.kind !== 'name' || renderHead(head) !== half) {
      continue
    }

    const name = group.nodes[1]

    if (name?.kind === 'name') {
      names.push(renderHead(name))
    } else if (name?.kind === 'group' && name.nodes[0]?.kind === 'name') {
      // `mint task, like code-task` carries the name as the head of a group
      names.push(renderHead(name.nodes[0]))
    }
  }

  return names
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
      const resolved = resolveImport(millRoot, file, path)

      if (resolved) {
        walk(resolved)
      }
      // an unresolvable import is not a problem here: a mill loads stdlib forms (`@term/seed/code/lang`) for
      // its `like` annotations, and those are not grammar files. test/compile/mill-grammar.ts is what checks
      // that every load names something real.
    }
  }

  walk(entry)

  return { text: parts.join('\n\n'), files }
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
