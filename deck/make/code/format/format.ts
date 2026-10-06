// The formatter: re-print a `.tree` CST in canonical form, by the five rules in note/term/format-rules.md, and refuse
// any layout that mills to a different program. The pass is Term, format/layout.tree (self-hosting, 2026-10-06), and its
// header says what each rule does. This face keeps the options as its callers write them (a `Set` of extra stacking
// heads, `undefined` for a choice left to the file) and hands in the meaning check, the milled program and the import
// paths (format/meaning.ts). Pure and browser-safe.

import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import { importsOf, programOf } from '@term/make/code/format/meaning'
import * as port from '@term/make/code/format/layout'

// how a tree is printed. `wrap: false` keeps every comment line exactly as written; `stack` names heads to keep stacked
// beyond the ones always stacked; `calls: false` turns rule 3 off; `lean` and `role` are the file's, as the build reads
// them; `dialect` marks a grammar's dialect
export type FormatOptions = {
  wrap?: boolean
  stack?: Set<string>
  calls?: boolean
  lean?: boolean
  role?: string | null
  dialect?: boolean
}

const given = <T>(value: T | undefined | null): port.Maybe<T> =>
  value === undefined || value === null ? { form: 'none' } : { form: 'some', value }

function optionsOf(options: FormatOptions): port.LayoutOptions {
  return {
    wrap: given(options.wrap),
    stack: [...(options.stack ?? [])],
    calls: given(options.calls),
    lean: given(options.lean),
    role: given(options.role),
    dialect: given(options.dialect),
  }
}

// one group laid out as the formatter lays it out at `depth`, one string per line, comments included, for the layout
// lint (L044)
export function formatGroupLines(
  group: GroupNode,
  depth: number,
  options: FormatOptions = {},
  value = false,
  parent?: GroupNode,
): string[] {
  return port.formatGroupLines(group, depth, optionsOf(options), value, given(parent))
}

// which parts of a group stand in a value position (rule 3), for a caller walking the tree beside the formatter
export function valuePlaces(group: GroupNode): boolean[] {
  return port.valuePlaces(group)
}

// The layout, from the tree, with no meaning check: for a caller that holds only a tree
export function formatTree(tree: RootNode, options: FormatOptions = {}): string {
  return port.formatTree(tree, optionsOf(options))
}

export type FormatReport = {
  text: string
  // why the result was refused and the file returned as written, when it was
  refused?: string
}

// Format source text, and say what happened. Tolerant: a file that does not parse comes back unchanged, and a file that
// mills is held to its own meaning
export function formatReport(source: { file: string; text: string }, options: FormatOptions = {}): FormatReport {
  const report = port.formatReport(
    source.file,
    source.text,
    optionsOf(options),
    (tree, file, lean) => given(programOf(tree, file, lean)),
    (file, text) => importsOf(file, text),
  )

  return report.refused.form === 'some' ? { text: report.text, refused: report.refused.value } : { text: report.text }
}

// format source text. Tolerant: if it does not parse, or its layout cannot be proven to mean the same, the original
// text is returned unchanged
export function format(source: { file: string; text: string }, options: FormatOptions = {}): string {
  return formatReport(source, options).text
}
