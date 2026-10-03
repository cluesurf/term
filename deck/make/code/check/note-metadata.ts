// `note <word>` written as METADATA, the old spelling of `mark <word>` (note/term/plan/await-by-default-and-mark-
// metadata.md, section 4). Read off the concrete tree, because the mill mints `mark async` and `note async` as one
// form and the program cannot tell which was written. Three readers share it, so they cannot disagree about which
// `note` is metadata: the compiler's `note-metadata` warning (compile/compile.ts), the lint rule that rewrites it
// (L053, lint/rules/note-metadata.ts), and the repository fixer `pnpm term:mark-metadata`.
//
// WHICH `note` IS METADATA, decided by FORM:
//   - its word is one of the metadata words below, written bare (never a text literal: `note <Upload too large>`
//     is documentation and stays `note`)
//   - nothing follows the word, except a statement body under `note unsafe` (the guarded block) and the `name`
//     of `note feature, name x` / `note platform, name x`
//   - it is not under a `call` (a `note` there is read as an argument, quirk 6), a `take` (a CLI parameter's help
//     text), a `link` (a field's documentation), a `like` (a callback type, where nothing reads it) or a `twin`
//
// `note private` is in the list, so the fixer and the lint rule rewrite it, but the compiler warns about it under
// its own older name, `note-private` (check/private.ts), and not twice.

import type { Span } from '@term/make/code/parser/diagnostic'
import type { GroupNode, Node, RootNode } from '@term/make/code/parser/tree'
import { headWord, spanOfNode, wordOf } from '@term/make/code/compile/mill-run'

export const METADATA_WORDS = new Set([
  'async',
  'native',
  'unsafe',
  'draft',
  'stable',
  'unstable',
  'deprecated',
  'keep',
  'open',
  'roam',
  'feature',
  'platform',
  'shared',
  'private',
])

// the parents under which a `note` is never metadata
const NOT_METADATA_UNDER = new Set(['call', 'take', 'link', 'like', 'twin'])

export type NoteSite = {
  // the metadata word
  word: string
  // the `note` word itself, which a fix replaces with `mark`
  span: Span
}

// every metadata `note` in a parsed file, in source order
export function noteMetadataSites(tree: RootNode, source?: string): NoteSite[] {
  const sites: NoteSite[] = []

  const visit = (group: GroupNode, parent: string | undefined): void => {
    const head = headWord(group)

    if (head === 'note' && !NOT_METADATA_UNDER.has(parent ?? '')) {
      const site = metadataOf(group)

      if (site) {
        sites.push(site)
      }
    }

    for (const child of group.nodes.slice(1)) {
      if (child.kind === 'group') {
        visit(child, head)
      }
    }
  }

  for (const group of tree.nodes) {
    visit(group, undefined)
  }

  return source === undefined ? sites : realigned(sites, source, site => `note ${site.word}`)
}

function metadataOf(group: GroupNode): NoteSite | undefined {
  const [noteWord, first, ...rest] = group.nodes
  const word = first?.kind === 'name' ? wordOf(first) : first?.kind === 'group' && first.nodes.length === 1 ? wordOf(first) : undefined
  const span = spanOfNode(noteWord)

  if (!word || !span || !METADATA_WORDS.has(word)) {
    return undefined
  }

  // what may follow the word: a guarded body under `unsafe`, a `name` under feature / platform, else nothing
  const fits =
    word === 'unsafe' ||
    rest.length === 0 ||
    ((word === 'feature' || word === 'platform') && rest.every(isName))

  return fits ? { word, span } : undefined
}

function isName(node: Node): boolean {
  return node.kind === 'group' && headWord(node) === 'name'
}

// A token's line is off by the newlines inside any multi-line text literal above it: the tokenizer counts a
// literal that spans lines as one line. So a span read off the tree is the START of a search, and the site is the
// first line at or after it (and after the previous site) whose text at that column is what the site says is
// there. The two readers that edit text by these spans (the lint fixes and the repository fixer) need the real line.
function realigned<T extends { span: Span }>(sites: T[], source: string, needle: (site: T) => string): T[] {
  const lines = source.split('\n')
  let floor = 0

  return sites.map(site => {
    const { line, column } = site.span.start
    const want = needle(site)

    for (let at = Math.max(line, floor); at < lines.length; at++) {
      if ((lines[at] ?? '').slice(column, column + want.length) === want) {
        floor = at + 1

        return at === line ? site : { ...site, span: { ...site.span, start: { line: at, column }, end: { line: at, column: site.span.end.column } } }
      }
    }

    return site
  })
}

// ---- the `wait true` markers ----
//
// `wait true` under a call says "await this call", which a call to an async TASK does with nothing written since
// the default flipped (section 1). Read off the concrete tree for the same reason: the program cannot tell an await
// the source wrote from one async resolution inserted.

export type WaitSite = {
  // the callee's name as written (`fetch-page`, `fs-promise/read-file`)
  callee: string
  // the text to remove: the whole line when `wait true` stands on its own, else `, wait true` after the call
  remove: Span
  // where the marker is, for a finding
  span: Span
  // the marker is on a task DEFINITION rather than a call
  definition: boolean
}

export function waitTrueSites(tree: RootNode, source: string): WaitSite[] {
  const sites: WaitSite[] = []
  const lines = source.split('\n')

  const visit = (group: GroupNode, parent: GroupNode | undefined): void => {
    if (
      parent &&
      headWord(group) === 'wait' &&
      group.nodes.length === 2 &&
      wordOf(group.nodes[1]) === 'true' &&
      (group.nodes[1]?.kind !== 'group' || group.nodes[1].nodes.length === 1)
    ) {
      const span = spanOfNode(group)
      const callee = calleeOf(parent)

      if (span && callee) {
        sites.push({ ...callee, span, remove: span })
      }
    }

    for (const child of group.nodes.slice(1)) {
      if (child.kind === 'group') {
        visit(child, group)
      }
    }
  }

  for (const group of tree.nodes) {
    visit(group, undefined)
  }

  return realigned(sites, source, () => 'wait true').map(site => ({ ...site, remove: removalOf(site.span, lines) }))
}

// the call a `wait true` sits under: `call f ...` names f, a bare head `f(x)` or `f` over arguments names f, and a
// `task` is the definition marker
function calleeOf(parent: GroupNode): { callee: string; definition: boolean } | undefined {
  const head = headWord(parent)

  if (!head) {
    return undefined
  }

  if (head === 'task' || head === 'bind') {
    return { callee: wordOf(parent.nodes[1]) ?? '', definition: true }
  }

  if (head === 'call') {
    const named = wordOf(parent.nodes[1])

    return named ? { callee: named, definition: false } : undefined
  }

  return { callee: head, definition: false }
}

// the source to cut: `wait true` alone on its line takes the line with it, and `, wait true` after a call on the
// same line takes the comma
function removalOf(span: Span, lines: string[]): Span {
  const line = lines[span.start.line] ?? ''

  if (line.trim() === 'wait true') {
    return { start: { line: span.start.line, column: 0 }, end: { line: span.start.line + 1, column: 0 } }
  }

  const before = line.slice(0, span.start.column)
  const comma = before.search(/,\s*$/)
  const end = span.start.column + 'wait true'.length

  return {
    start: { line: span.start.line, column: comma >= 0 ? comma : span.start.column },
    end: { line: span.start.line, column: end },
  }
}
