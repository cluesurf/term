// A face over analysis.tree, the port of this module (term-cli-in-term-0099, live since term-cli-in-term-0117). The
// original is kept at tmp/retired/flow/analyze.ts. `hoverAt`'s maybe is unboxed to undefined, `analyze` with no
// options hands the port an empty record, and `forEachExpression` walks symbol-index.tree's `expressions-of`. Its
// TypeScript callers (test/server/run.ts, incremental.ts, test/flow/lsp.ts) keep this API until they move.
import type { Expression, Program } from '@term/make/code/compile/node'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import type { Resolver } from '@term/make/code/compile/load'
import type { CompileCache } from '@term/make/code/compile/cache'
import * as emitted from '@term/flow/code/analysis'
import * as emittedIndex from '@term/flow/code/symbol-index'

// the emitted port may load as CommonJS (deck/flow/package.json has no `"type": "module"`), its exports under `default`
const port = ((emitted as { default?: unknown }).default ?? emitted) as any
const index = ((emittedIndex as { default?: unknown }).default ?? emittedIndex) as any

export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }
export type LspDiagnostic = {
  range: LspRange
  severity: number
  code: number | string
  source: string
  message: string
  relatedInformation?: { location: { uri: string; range: LspRange }; message: string }[]
  data?: unknown
}

export const toRange = (span: Span): LspRange => port.toRange(span)

export function toLspDiagnostic(d: Diagnostic): LspDiagnostic {
  return port.toLspDiagnostic(d)
}

export function analyze(
  document: { file: string; text: string },
  options?: { resolve?: Resolver; cache?: CompileCache; roleOf?: (file: string) => string | null | undefined },
): { diagnostics: LspDiagnostic[]; program?: Program } {
  return port.analyze(document, options ?? {})
}

export function within(span: Span, p: LspPosition): boolean {
  return port.within(span, p)
}

export function hoverAt(program: Program, position: LspPosition): string | undefined {
  const answer = port.hoverAt(program, position)
  return answer.form === 'some' ? answer.value : undefined
}

export function forEachExpression(program: Program, visit: (node: Expression) => void): void {
  for (const node of index.expressionsOf(program)) visit(node)
}
