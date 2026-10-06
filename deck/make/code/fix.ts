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
//
// The derivation and the applying are Term, fixing.tree (self-hosting, 2026-10-06). This face keeps the signatures its
// callers use: an absent answer as `undefined`, and the import lookup as an optional option.

import type { Diagnostic, Edit, Fix, Span } from '@term/make/code/parser/diagnostic'
import * as fixing from '@term/make/code/fixing'

// the compiler diagnostics a fix can be offered for, by the checker (a near spelling, a typed hole) or by this module
// (an old spelling, an import), and whether those fixes are sure (written by `term scan --fix`) or guesses (offered
// only). `term show kink` says so beside each
export const FIXABLE: Map<string, 'sure' | 'guess'> = fixing.fixable()

// what an import lookup answers: every module the project can reach that exports the name, the one to prefer first
// (make/code/resolve.ts `findModulesExporting`), and none when nothing does
export type ExportLookup = (name: string) => { importPath: string }[]

// the import paths a lookup answers, as the Term side takes them
function pathsOf(findExport: ExportLookup): (name: string) => string[] {
  return name => findExport(name).map(found => found.importPath)
}

// the text under a span, or undefined when the span reaches past the text
export function textAt(text: string, span: Span): string | undefined {
  const found = fixing.textAt(text, span)

  return found.form === 'some' ? found.value : undefined
}

// the identifier a diagnostic's span names, read off the span's first line
export function nameIn(text: string, span: Span): string | undefined {
  const found = fixing.nameIn(text, span)

  return found.form === 'some' ? found.value : undefined
}

// the edit that imports `name` from `importPath`
export function importEdit(text: string, importPath: string, name: string): Edit {
  return fixing.importEdit(text, importPath, name)
}

// every fix for one diagnostic: the compiler's own, then those read off the text. `findExport` is asked only for an
// unknown name, because it searches the file system, and an editor computing fixes for a save must not pay for it
export function fixesOf(diagnostic: Diagnostic, text: string, options?: { findExport?: ExportLookup }): Fix[] {
  const findExport = options?.findExport

  return fixing.fixesOf(diagnostic, text, Boolean(findExport), findExport ? pathsOf(findExport) : () => [])
}

// the fixes read off the text alone, by the diagnostic's name and span
export function textFixes(name: string, span: Span, text: string): Fix[] {
  return fixing.textFixes(name, span, text)
}

// the name under an unknown-name span, imported: one fix per module that exports it, none sure
export function importFixes(text: string, span: Span, findExport: ExportLookup): Fix[] {
  return fixing.importFixes(text, span, pathsOf(findExport))
}

// Apply fixes to a text. Every edit of a fix lands or none does, and a refused fix is named with why
export function applyFixes(text: string, fixes: Fix[]): { text: string; applied: Fix[]; refused: { fix: Fix; reason: string }[] } {
  return fixing.applyFixes(text, fixes)
}
