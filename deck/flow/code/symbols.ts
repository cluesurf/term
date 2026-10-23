// A face over symbol-index.tree, the port of this module (term-cli-in-term-0098, live since term-cli-in-term-0117).
// The original is kept at tmp/retired/flow/symbols.ts. A maybe is unboxed to undefined, a `findName` pattern
// `(?:^|\s)(?:task|rule)\s+$` is handed over as its head words, a bare name to `occurrencesOf` as `{ name }`, and the
// visitors walk the port's lists. Its TypeScript callers (test/server/run.ts, test/flow/lsp.ts) keep this API until
// they move to the port's.
import type { Expression, Program } from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'
import type { LspPosition } from '@term/flow/code/analyze'
import * as emitted from '@term/flow/code/symbol-index'

// the emitted port may load as CommonJS (deck/flow/package.json has no `"type": "module"`), its exports under `default`
const port = ((emitted as { default?: unknown }).default ?? emitted) as any

export type SymbolKind = 'function' | 'type' | 'variant' | 'trait' | 'parameter' | 'local'
export type Definition = { name: string; kind: SymbolKind; span: Span; detail: string; at?: Span }
export type Reference = { name: string; span: Span; at?: Span }
export type FunctionScope = {
  name: string
  span: Span
  locals: { name: string; kind: SymbolKind; detail: string; span: Span; at?: Span }[]
}
export type SymbolIndex = {
  definitions: Map<string, Definition>
  references: Reference[]
  functions: Definition[]
  scopes: FunctionScope[]
  signatures: Map<string, { params: { name: string; type: string }[]; result: string }>
}
export type Named = { name: string; scope?: FunctionScope }

const unbox = <T>(value: { form: string; value?: T }): T | undefined => (value.form === 'some' ? value.value : undefined)

// `(?:^|\s)(?:task|rule)\s+$` -> ['task', 'rule']
function headsOf(after: RegExp | undefined): string[] {
  if (!after) return []
  const match = /^\(\?:\^\|\\s\)(?:\(\?:([A-Za-z|-]+)\)|([A-Za-z-]+))\\s\+\$$/.exec(after.source)
  if (!match) throw new Error(`symbols: a pattern the port cannot take: ${after.source}`)
  return (match[1] ?? match[2]!).split('|')
}

export function writtenName(name: string): string {
  return port.writtenName(name)
}

export function findName(lines: string[], span: Span, name: string, after?: RegExp): Span | undefined {
  return unbox(port.findName(lines, span, name, headsOf(after)))
}

export function buildIndex(program: Program, text?: string): SymbolIndex {
  return port.buildIndex(program, text ?? '')
}

export function signaturesOf(program: Program): SymbolIndex['signatures'] {
  return port.signaturesOf(program)
}

export function referenceAt(index: SymbolIndex, position: LspPosition, strict = false): Reference | undefined {
  return unbox(port.referenceAt(index, position, strict))
}

export function symbolAt(index: SymbolIndex, position: LspPosition, strict = false): Named | undefined {
  return unbox(port.symbolAt(index, position, strict))
}

export function occurrencesOf(index: SymbolIndex, name: string | Named): Span[] {
  return port.occurrencesOf(index, typeof name === 'string' ? { name } : name)
}

export function scopeAt(index: SymbolIndex, position: LspPosition): Definition[] {
  return port.scopeAt(index, position)
}

export function forEachCall(program: Program, visit: (call: Extract<Expression, { form: 'call' }>) => void): void {
  for (const node of port.callsOf(program)) visit(node)
}

export function forEachExpression(program: Program, visit: (node: Expression) => void): void {
  for (const node of port.expressionsOf(program)) visit(node)
}

export function callAt(program: Program, position: LspPosition): { name: string; activeParam: number } | undefined {
  return unbox(port.callAt(program, position))
}
