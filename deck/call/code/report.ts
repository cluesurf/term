// Shared CLI diagnostic reporting. The compiler already has a rich, chalk-colored renderer (`render` in
// parser/diagnostic.ts) that prints a rustc-style frame: a colored `error[name code]: message` header, a `--> file:line:col`
// locator, and the offending source line with a caret underline. The CLI commands historically printed a flat one-liner
// instead. This module wires the rich renderer into the CLI, reading each diagnostic's source from disk so the frame can
// show context. Color follows `chalk.level` (auto-disabled when output is not a TTY).

import { readFileSync } from 'node:fs'
import { render } from '@cluesurf/make/code/parser/diagnostic'
import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'

// the source lines of a diagnostic's file, read from disk. An optional `text` is used when the file is the one already
// in memory (the common single-file case), avoiding a re-read.
function sourceLines(diagnostic: Diagnostic, text?: string): string[] {
  if (text !== undefined) {
    return text.split('\n')
  }

  try {
    return readFileSync(diagnostic.file, 'utf8').split('\n')
  } catch {
    return []
  }
}

// render ONE diagnostic into its rich, colored frame string (no trailing newline).
export function renderDiagnostic(
  diagnostic: Diagnostic,
  text?: string,
): string {
  return render(diagnostic, sourceLines(diagnostic, text))
}

// print a diagnostic's rich frame to stderr (errors) or stdout (warnings), with a trailing blank line so consecutive
// frames stay readable.
export function printDiagnostic(
  diagnostic: Diagnostic,
  text?: string,
): void {
  const frame = renderDiagnostic(diagnostic, text)

  if (diagnostic.severity === 'warning') {
    console.log(frame + '\n')
  } else {
    console.error(frame + '\n')
  }
}

// print a list of diagnostics, each as a rich frame. `text` (the in-memory source) is used for diagnostics whose file is
// the compiled file; diagnostics in imported modules are read from disk.
export function printDiagnostics(
  diagnostics: Diagnostic[],
  forFile?: { file: string; text: string },
): void {
  for (const diagnostic of diagnostics) {
    printDiagnostic(
      diagnostic,
      forFile && diagnostic.file === forFile.file
        ? forFile.text
        : undefined,
    )
  }
}
