// FIXES AS DATA: the edits that resolve a diagnostic, for `term scan` (JSON, and `--fix` to apply them) and the
// language server (quick fixes). ONE place derives them, so the editor and an agent are offered the same change.
//
// Two sources. The compiler attaches a fix where it already knows the answer (a near spelling in check/resolve.ts,
// the names that fit a typed hole in check/infer.ts). The rest are read off the text here, because they need the
// source the diagnostic points into (an old spelling's exact characters) or the file system (which module exports a
// name), and the checker has neither.
//
// An edit carries `was`, the text its span held when it was made. Applying refuses an edit whose span no longer holds
// that text, so a fix computed against one version of a file is never written over another.

import type { Diagnostic, Edit, Fix, Span } from '@term/make/code/parser/diagnostic'

// the compiler diagnostics a fix can be offered for, by the checker (a near spelling, a typed hole) or by this module
// (an old spelling, an import), and whether those fixes are sure (written by `term scan --fix`) or guesses (offered
// only). `term show kink` says so beside each, so this map and the code below change together
export const FIXABLE = new Map<string, 'sure' | 'guess'>([
  ['note-private', 'sure'],
  ['note-metadata', 'sure'],
  ['unknown-name', 'guess'],
  ['typed-hole', 'guess'],
])

// what an import lookup answers: every module the project can reach that exports the name, the one to prefer first
// (make/code/resolve.ts `findModulesExporting`), and none when nothing does
export type ExportLookup = (name: string) => { importPath: string }[]

// how many homes of one name are offered as imports. A name with more is a common word, and the first few are the ones
// the lookup ranks as its public homes
const IMPORT_LIMIT = 4

// the text under a span, or undefined when the span reaches past the text
export function textAt(text: string, span: Span): string | undefined {
  const start = offsetOf(text, span.start.line, span.start.column)
  const end = offsetOf(text, span.end.line, span.end.column)

  if (start === undefined || end === undefined || end < start) {
    return undefined
  }

  return text.slice(start, end)
}

// a line and column (zero-based, in the parser's units, which are UTF-16 code units on TypeScript) as an offset into
// the text, or undefined past its end. A column past a line's end is refused rather than read into the next line
function offsetOf(text: string, line: number, column: number): number | undefined {
  let at = 0

  for (let current = 0; current < line; current++) {
    const next = text.indexOf('\n', at)

    if (next < 0) {
      return undefined
    }

    at = next + 1
  }

  const end = text.indexOf('\n', at)
  const length = (end < 0 ? text.length : end) - at

  return column <= length ? at + column : undefined
}

// the identifier a diagnostic's span names, read off the span's first line: the name itself (`foo`, `foo(x)`), or the
// word after a longhand head (`read foo`, `call foo`, `make foo`). A call's span runs over its argument lines, and the
// name is the first thing on the first of them
export function nameIn(text: string, span: Span): string | undefined {
  const line = text.split('\n')[span.start.line]

  if (line === undefined) {
    return undefined
  }

  const end = span.end.line === span.start.line ? span.end.column : line.length
  const first = line.slice(span.start.column, end).trim().replace(/^(?:call|read|make)\s+/, '')

  return /^[a-z][A-Za-z0-9-]*/.exec(first)?.[0]
}

// the edit that imports `name` from `importPath`: a `find` as the first line under an existing `load` of that module,
// else a new load block at the top of the file
export function importEdit(text: string, importPath: string, name: string): Edit {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line === `load ${importPath}` || line.startsWith(`load ${importPath} `))
  const line = at >= 0 ? at + 1 : 0
  const where = { line, column: 0 }

  return {
    span: { start: where, end: where },
    text: at >= 0 ? `  find ${name}\n` : `load ${importPath}\n  find ${name}\n\n`,
    was: '',
  }
}

// every fix for one diagnostic: the compiler's own, then those read off the text. `findExport` is asked only for an
// unknown name, because it searches the file system, and an editor computing fixes for a save must not pay for it
export function fixesOf(diagnostic: Diagnostic, text: string, options?: { findExport?: ExportLookup }): Fix[] {
  const fixes: Fix[] = [...(diagnostic.fixes ?? []), ...textFixes(diagnostic.name, diagnostic.span, text)]

  if (diagnostic.name === 'unknown-name' && options?.findExport) {
    fixes.push(...importFixes(text, diagnostic.span, options.findExport))
  }

  return fixes
}

// the fixes read off the text alone, by the diagnostic's name and span: what an editor can still offer for a
// diagnostic a client sends back with its name and nothing else
export function textFixes(name: string, span: Span, text: string): Fix[] {
  const fixes: Fix[] = []

  // the old spelling of privacy, which has exactly one current spelling. The checker's span is the `note private` line
  // (check/private.tree), and the edit expects whatever it holds, so a span that moved is refused when applied
  if (name === 'note-private') {
    const was = textAt(text, span)

    if (was !== undefined) {
      fixes.push({ title: 'Write `mark private` (the current spelling)', sure: true, edits: [{ span, text: 'mark private', was }] })
    }
  }

  // the old spelling of metadata, `note <word>`: the span starts at the `note`, and the word after it stays as written
  if (name === 'note-metadata') {
    const word = { ...span, end: { line: span.start.line, column: span.start.column + 4 } }

    if (textAt(text, word) === 'note') {
      fixes.push({ title: 'Write `mark` (metadata is `mark`, `note` is the old spelling)', sure: true, edits: [{ span: word, text: 'mark', was: 'note' }] })
    }
  }

  return fixes
}

// the name under an unknown-name span, imported: one fix per module that exports it, none sure, since two modules may
// define it (`join` is a path's and a text utility's) and the author may have meant a local of a near spelling instead
export function importFixes(text: string, span: Span, findExport: ExportLookup): Fix[] {
  const name = nameIn(text, span)

  if (!name) {
    return []
  }

  const homes = [...new Set(findExport(name).map(found => found.importPath))]

  return homes
    .slice(0, IMPORT_LIMIT)
    .map(importPath => ({ title: `Import ${name} from ${importPath}`, sure: false, edits: [importEdit(text, importPath, name)] }))
}

// two spans overlap when either starts before the other ends. Two insertions at one place overlap too: their order
// would be a guess
function overlaps(a: Span, b: Span): boolean {
  const before = (x: Span['start'], y: Span['start']): boolean => x.line < y.line || (x.line === y.line && x.column < y.column)
  const same = (x: Span['start'], y: Span['start']): boolean => x.line === y.line && x.column === y.column

  if (same(a.start, b.start)) {
    return true
  }

  return before(a.start, b.end) && before(b.start, a.end)
}

// Apply fixes to a text. Every edit of a fix lands or none does: a fix whose edit no longer finds its `was`, or that
// overlaps an edit already taken, is refused whole and named. Edits are written from the end of the text back, so an
// earlier one's offsets stay true
export function applyFixes(text: string, fixes: Fix[]): { text: string; applied: Fix[]; refused: { fix: Fix; reason: string }[] } {
  const applied: Fix[] = []
  const refused: { fix: Fix; reason: string }[] = []
  const taken: Edit[] = []

  for (const fix of fixes) {
    const stale = fix.edits.find(edit => textAt(text, edit.span) !== edit.was)
    const clash = fix.edits.find(edit => taken.some(other => overlaps(edit.span, other.span)))

    if (stale) {
      refused.push({ fix, reason: `the text at ${stale.span.start.line + 1}:${stale.span.start.column + 1} is no longer "${stale.was}"` })
    } else if (clash) {
      refused.push({ fix, reason: `it changes text another fix already changes, at ${clash.span.start.line + 1}:${clash.span.start.column + 1}` })
    } else {
      applied.push(fix)
      taken.push(...fix.edits)
    }
  }

  const ordered = [...taken].sort(
    (a, b) => b.span.start.line - a.span.start.line || b.span.start.column - a.span.start.column,
  )
  let out = text

  for (const edit of ordered) {
    const start = offsetOf(out, edit.span.start.line, edit.span.start.column)!
    const end = offsetOf(out, edit.span.end.line, edit.span.end.column)!

    out = out.slice(0, start) + edit.text + out.slice(end)
  }

  return { text: out, applied, refused }
}
