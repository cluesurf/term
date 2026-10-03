// The workspace half of navigation: references, rename, symbols and incoming calls across every file of a package,
// not only the open one.
//
// WHAT COUNTS AS A REFERENCE ACROSS FILES is what the build binds by: a name reaches another file only through
// `load ... / find` (note/term/project/module-scope.md). So a file refers to a definition in module M when it has a
// `load` whose path RESOLVES to M's file and `find`s the name, and does not define the name itself. Matching the
// name alone would rename every same-named task in the package, which module scope exists to keep apart.
//
// THE SCOPE IS A PACKAGE, the files `term make` builds from the nearest `deck.tree` (findTreeFiles in
// call/code/make.ts, which skips drafts, manifests, role files and nested packages). The defining file's package and
// the package of every open document are searched. A package that imports this one from elsewhere on disk is not.
//
// Each file is read once per question, its text from the open document when there is one, and milled alone with
// its role and `mark lean` (no type check, no imports): a reference is a name in a position, and the mill already
// knows every position. A file that does not hold the name as a whole word is never milled.

import { realpathSync, readFileSync } from 'node:fs'
import { analyze as analyzeSource } from '@term/make/code/analyze'
import { importFindsOf, makeParseMemo } from '@term/make/code/compile/load'
import type { ParseMemo, Resolver } from '@term/make/code/compile/load'
import type { Span } from '@term/make/code/parser/diagnostic'
import { scanDefs } from '@term/make/code/resolve'
import { findTreeFiles } from '@term/call/code/make'
import { preprocessTests } from '@term/call/code/test-preprocess'
import { buildIndex, findName, occurrencesOf } from '@term/flow/code/symbols'
import type { SymbolIndex } from '@term/flow/code/symbols'
import { IDENTITY, makeMapping } from '@term/flow/code/text'
import type { Mapping } from '@term/flow/code/text'

// a package with more files than this is not searched file by file: the question would take longer than the
// editor waits for it. @term/bind (3,091 files) is the one package in the tree above it.
export const WORKSPACE_FILE_CAP = 4000

export type Readers = {
  role?: string
  lean: boolean
}

export type WorkspaceHost = {
  // the open document's text for a file, when one is open
  textOf(file: string): string | undefined
  // the role and `mark lean` a file's role rule gives it
  readersOf(file: string): Readers
  // the resolver a package's build uses
  resolverOf(root: string): Resolver
}

export type FileIndex = {
  file: string
  text: string
  index: SymbolIndex
  // compiler coordinates to the author's (a test file is compiled rewritten)
  map: Mapping
}

// a name written as a whole word somewhere in the text: the cheap test that keeps most files from being milled
export function mentions(text: string, name: string): boolean {
  let at = text.indexOf(name)

  while (at >= 0) {
    const before = at > 0 ? text[at - 1]! : ' '
    const after = text[at + name.length] ?? ' '

    if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after)) {
      return true
    }

    at = text.indexOf(name, at + 1)
  }

  return false
}

export function canonical(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

export class Workspace {
  // the build's file list per package, until a file is created or deleted under it
  private readonly lists = new Map<string, string[]>()

  constructor(private readonly host: WorkspaceHost) {}

  // forget what is cached for a package (a file created, deleted or renamed), or for all of them
  forget(root?: string): void {
    if (root) {
      this.lists.delete(root)
    } else {
      this.lists.clear()
    }
  }

  files(root: string): string[] {
    let list = this.lists.get(root)

    if (!list) {
      list = findTreeFiles(root).filter(
        f => !/[\\/](?:tmp|\.base|link)[\\/]/.test(f.slice(root.length)),
      )
      this.lists.set(root, list)
    }

    return list.length > WORKSPACE_FILE_CAP ? [] : list
  }

  read(file: string): string | undefined {
    const open = this.host.textOf(file)

    if (open !== undefined) {
      return open
    }

    try {
      return readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  }

  // one file milled alone, with its own role and lean flag, indexed with name spans
  indexOf(file: string, text: string): FileIndex | undefined {
    const readers = this.host.readersOf(file)

    let compiled = text
    let map: Mapping = IDENTITY

    // only a file read as code is rewritten: a view document, a data file and a mill definition have their own reader
    if (!['view', 'host', 'mill'].includes(readers.role ?? '') && /^\s*test /m.test(text)) {
      const rewritten = preprocessTests(text)
      compiled = rewritten.text
      map = makeMapping(text, compiled, rewritten.origin)
    }

    try {
      const milled = analyzeSource({ file, text: compiled }, readers)

      return milled.program
        ? { file, text, index: buildIndex(milled.program, compiled), map }
        : undefined
    } catch {
      return undefined
    }
  }

  // every top-level definition of every file in the packages, matched against a query
  symbols(
    roots: string[],
    query: string,
    limit = 500,
  ): { name: string; kind: string; file: string; line: number; column: number }[] {
    const out: { name: string; kind: string; file: string; line: number; column: number }[] = []
    const wanted = query.toLowerCase()

    for (const root of roots) {
      for (const file of this.files(root)) {
        const text = this.read(file)

        if (text === undefined) {
          continue
        }

        for (const def of scanDefs(text)) {
          if (wanted && !fuzzy(def.name.toLowerCase(), wanted)) {
            continue
          }

          out.push({ name: def.name, kind: def.kind, file, line: def.line, column: def.column })

          if (out.length >= limit) {
            return out
          }
        }
      }
    }

    return out
  }

  // The files that import `name` from `definer`, and where. `finds` are the `find <name>` tokens (a rename edits
  // these), `spans` the name's other occurrences in that file (a rename edits these too, unless the import is
  // aliased with `find x, name y`, when the file's own uses are of `y`).
  importers(
    roots: string[],
    name: string,
    definer: string,
  ): {
    file: string
    finds: Span[]
    spans: Span[]
    // where an aliased import's OTHER name is used (`find shout, name yell`, then `call yell`): references of the
    // definition, and never edited by a rename
    aliasSpans: Span[]
    aliased: boolean
    index?: FileIndex
  }[] {
    const target = canonical(definer)
    const out: ReturnType<Workspace['importers']> = []
    const parsed: ParseMemo = makeParseMemo()
    const seen = new Set<string>()

    for (const root of roots) {
      const resolve = this.host.resolverOf(root)

      for (const file of this.files(root)) {
        const real = canonical(file)

        if (real === target || seen.has(real)) {
          continue
        }

        seen.add(real)

        const text = this.read(file)

        if (text === undefined || !mentions(text, name)) {
          continue
        }

        const finds: Span[] = []
        const lines = text.split('\n')

        let aliased = false

        for (const entry of importFindsOf({ file: real, text }, parsed)) {
          const i = entry.names.indexOf(name)

          if (i < 0) {
            continue
          }

          let resolved: string | undefined

          try {
            resolved = resolve(entry.path, real)?.file
          } catch {
            resolved = undefined
          }

          if (!resolved || canonical(resolved) !== target) {
            continue
          }

          const line = entry.spans[i]

          if (!line) {
            continue
          }

          const token = findName(lines, line, name, /(?:^|\s)find\s+$/)

          if (token) {
            finds.push(token)
          }

          if (entry.aliases[i]) {
            aliased = true
          }
        }

        if (finds.length === 0) {
          continue
        }

        const indexed = this.indexOf(real, text)
        const spans =
          indexed && !indexed.index.definitions.has(name)
            ? occurrencesOf(indexed.index, name).map(span => outerSpan(indexed.map, span))
            : []

        // the mill binds an alias's every use to the imported name, so the index already lists them under `name`,
        // written as the alias (symbols.ts reads the `find` lines for where)
        out.push({
          file: real,
          finds,
          spans: aliased ? [] : spans,
          aliasSpans: aliased ? spans : [],
          aliased,
          index: indexed,
        })
      }
    }

    return out
  }
}

export function outerSpan(map: Mapping, span: Span): Span {
  if (map.identity) {
    return span
  }

  const start = map.outer({ line: span.start.line, character: span.start.column }, 'start')
  const end = map.outer({ line: span.end.line, character: span.end.column }, 'end')

  return {
    start: { line: start.line, column: start.character },
    end: { line: end.line, column: end.character },
  }
}

// every character of the query appears in the name, in order (the matching an editor's symbol search expects)
function fuzzy(name: string, query: string): boolean {
  let at = 0

  for (const ch of query) {
    at = name.indexOf(ch, at)

    if (at < 0) {
      return false
    }

    at++
  }

  return true
}
