// The editor-facing analysis: run the compiler on a document and turn its output into the shapes an LSP client wants.
// `analyze` produces diagnostics (errors and warnings, with ranges) plus the typed program; `hoverAt` answers a
// hover request by finding the narrowest typed expression under the cursor. Pure: no streams, no document store.

import { compile } from '@cluesurf/make/code/compile/compile'
import type { Resolver } from '@cluesurf/make/code/compile/load'
import type { CompileCache } from '@cluesurf/make/code/compile/cache'
import type {
  Expression,
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'
import { showType } from '@cluesurf/make/code/compile/node'
import type {
  Diagnostic,
  Position as SeedPosition,
  Severity,
  Span,
} from '@cluesurf/make/code/parser/diagnostic'

// LSP geometry: 0-based line/character, exactly the compiler's own coordinates, so spans map across unchanged.
export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }
export type LspDiagnostic = {
  range: LspRange
  severity: number
  code: number
  source: string
  message: string
}

const SEVERITY: Record<Severity, number> = {
  error: 1,
  warning: 2,
  info: 3,
}

export const toRange = (span: Span): LspRange => ({
  start: { line: span.start.line, character: span.start.column },
  end: { line: span.end.line, character: span.end.column },
})

// one compiler diagnostic to the LSP shape (shared by the whole-program and incremental analyzers)
export function toLspDiagnostic(d: Diagnostic): LspDiagnostic {
  return {
    range: toRange(d.span),
    severity: SEVERITY[d.severity],
    code: d.code,
    source: 'seed',
    message: d.hint ? `${d.message} (${d.hint})` : d.message,
  }
}

export function analyze(
  document: { file: string; text: string },
  options?: { resolve?: Resolver; cache?: CompileCache },
): { diagnostics: LspDiagnostic[]; program?: Program } {
  // the editor needs the un-optimized program (every call site intact for navigation / find-references), not the
  // inlined / specialized shape the build emits
  const result = compile(document, { ...options, optimize: false })

  if (!result.ok) {
    return { diagnostics: result.diagnostics.map(toLspDiagnostic) }
  }

  return {
    program: result.program,
    diagnostics: result.warnings.map(toLspDiagnostic),
  }
}

// position p is within span (inclusive), comparing line then column
export function within(span: Span, p: LspPosition): boolean {
  const after = (a: SeedPosition) =>
    p.line > a.line || (p.line === a.line && p.character >= a.column)

  const before = (b: SeedPosition) =>
    p.line < b.line || (p.line === b.line && p.character <= b.column)

  return after(span.start) && before(span.end)
}

// the size of a span, for picking the narrowest match (a small column delta on one line beats a multi-line span)
function spanSize(span: Span): number {
  return (
    (span.end.line - span.start.line) * 100000 +
    (span.end.column - span.start.column)
  )
}

// the inferred type of the narrowest typed expression under the cursor, as a string, or undefined if none
export function hoverAt(
  program: Program,
  position: LspPosition,
): string | undefined {
  let best: { span: Span; type: string } | undefined
  forEachExpression(program, node => {
    if (!node.type || !within(node.span, position)) {
      return
    }

    if (!best || spanSize(node.span) < spanSize(best.span)) {
      best = { span: node.span, type: showType(node.type) }
    }
  })

  return best?.type
}

// visit every expression in the program (used for hover and any future position-based feature)
export function forEachExpression(
  program: Program,
  visit: (node: Expression) => void,
): void {
  for (const statement of program) {
    walkStatement(statement, visit)
  }
}

function walkStatement(
  node: Statement,
  visit: (node: Expression) => void,
): void {
  switch (node.form) {
    case 'let':
      walkExpression(node.init, visit)
      break
    case 'assign':
      walkExpression(node.target, visit)
      walkExpression(node.value, visit)
      break
    case 'expression':
      walkExpression(node.expr, visit)
      break
    case 'return':
      if (node.value) {
        walkExpression(node.value, visit)
      }

      break
    case 'throw':
      walkExpression(node.value, visit)
      break
    case 'hold':
      walkExpression(node.expr, visit)
      break
    case 'while':
      walkExpression(node.cond, visit)
      node.body.forEach(s => walkStatement(s, visit))
      break
    case 'if':
      for (const branch of node.branches) {
        walkExpression(branch.cond, visit)
        branch.body.forEach(s => walkStatement(s, visit))
      }

      node.otherwise?.forEach(s => walkStatement(s, visit))
      break
    case 'for-each':
      walkExpression(node.iterable, visit)
      node.body.forEach(s => walkStatement(s, visit))
      break
    case 'match':
      walkExpression(node.subject, visit)

      for (const branch of node.cases) {
        branch.body.forEach(s => walkStatement(s, visit))
      }

      node.otherwise?.forEach(s => walkStatement(s, visit))
      break
    case 'function':
      node.body.forEach(s => walkStatement(s, visit))
      break
    default:
      break
  }
}

function walkExpression(
  node: Expression,
  visit: (node: Expression) => void,
): void {
  visit(node)

  switch (node.form) {
    case 'binary':
      walkExpression(node.left, visit)
      walkExpression(node.right, visit)
      break
    case 'unary':
      walkExpression(node.operand, visit)
      break
    case 'call':
      walkExpression(node.callee, visit)
      node.args.forEach(a => walkExpression(a, visit))
      break
    case 'array':
      node.items.forEach(i => walkExpression(i, visit))
      break
    case 'map':
      for (const entry of node.entries) {
        walkExpression(entry.key, visit)
        walkExpression(entry.value, visit)
      }

      break
    case 'record':
      node.fields.forEach(f => walkExpression(f.value, visit))
      break
    case 'member':
      walkExpression(node.target, visit)
      break
    case 'await':
      walkExpression(node.expr, visit)
      break
    default:
      break
  }
}
