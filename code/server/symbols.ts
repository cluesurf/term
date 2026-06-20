// The symbol index: the static model an editor navigates. Built from a checked program, it records every definition
// (function, type, variant, trait, parameter, local) with its span and signature, every name reference with its
// span, and the scope visible at any position. Go-to-definition, find-references, rename, document symbols,
// completion, and signature help are all thin queries over this index. Spans are 0-based, matching the compiler and
// the LSP wire.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@/code/compile/node'
import { showType } from '@/code/compile/node'
import type { Span } from '@/code/parser/diagnostic'
import type { LspPosition } from '@/code/server/analyze'
import { within } from '@/code/server/analyze'

export type SymbolKind =
  | 'function'
  | 'type'
  | 'variant'
  | 'trait'
  | 'parameter'
  | 'local'
export type Definition = {
  name: string
  kind: SymbolKind
  span: Span
  detail: string
}
export type Reference = { name: string; span: Span }
// the names a function makes available, with the span where each is introduced (for scope-aware completion)
export type FunctionScope = {
  span: Span
  locals: Array<{
    name: string
    kind: SymbolKind
    detail: string
    span: Span
  }>
}

export type SymbolIndex = {
  definitions: Map<string, Definition>
  references: Array<Reference>
  functions: Array<Definition>
  scopes: Array<FunctionScope>
  // a function name -> its parameter types and result, for signature help
  signatures: Map<
    string,
    { params: Array<{ name: string; type: string }>; result: string }
  >
}

function signatureText(
  node: Extract<Statement, { form: 'function' }>,
): string {
  const params = node.params
    .map(p => `${p.name}: ${showType(p.type ?? { kind: 'unknown' })}`)
    .join(', ')
  return `(${params}) -> ${showType(node.result ?? { kind: 'unit' })}`
}

export function buildIndex(program: Program): SymbolIndex {
  const definitions = new Map<string, Definition>()
  const references: Array<Reference> = []
  const functions: Array<Definition> = []
  const scopes: Array<FunctionScope> = []
  const signatures = new Map<
    string,
    { params: Array<{ name: string; type: string }>; result: string }
  >()

  const define = (
    name: string,
    kind: SymbolKind,
    span: Span,
    detail: string,
  ): Definition => {
    const def = { name, kind, span, detail }
    if (!definitions.has(name)) definitions.set(name, def)
    return def
  }

  // top-level definitions first, so forward references resolve
  for (const statement of program) {
    switch (statement.form) {
      case 'function': {
        const def = define(
          statement.name,
          'function',
          statement.span,
          signatureText(statement),
        )
        functions.push(def)
        signatures.set(statement.name, {
          params: statement.params.map(p => ({
            name: p.name,
            type: showType(p.type ?? { kind: 'unknown' }),
          })),
          result: showType(statement.result ?? { kind: 'unit' }),
        })
        break
      }
      case 'record-type': {
        define(
          statement.name,
          'type',
          statement.span,
          statement.variants.length ? 'enum' : 'struct',
        )
        for (const v of statement.variants)
          define(
            v.name,
            'variant',
            statement.span,
            `${statement.name} variant`,
          )
        break
      }
      case 'mask':
        define(statement.name, 'trait', statement.span, 'trait')
        break
      default:
        break
    }
  }

  // references + per-function local scopes
  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'variable':
      case 'hole':
        references.push({ name: node.name, span: node.span })
        break
      case 'record':
        references.push({ name: node.name, span: node.span })
        node.fields.forEach(f => expr(f.value))
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'call':
        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'member':
        expr(node.target)
        break
      case 'await':
        expr(node.expr)
        break
      case 'array':
        node.items.forEach(expr)
        break
      case 'map':
        node.entries.forEach(e => {
          expr(e.key)
          expr(e.value)
        })
        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond)
          expr(b.value)
        })
        if (node.otherwise) expr(node.otherwise)
        break
      default:
        break
    }
  }

  const walkStatements = (
    body: Array<Statement>,
    locals: FunctionScope['locals'],
  ): void => {
    for (const s of body) {
      switch (s.form) {
        case 'let':
          expr(s.init)
          locals.push({
            name: s.name,
            kind: 'local',
            detail: showType(s.type ?? { kind: 'unknown' }),
            span: s.span,
          })
          break
        case 'assign':
          expr(s.target)
          expr(s.value)
          break
        case 'expression':
        case 'hold':
          expr(s.expr)
          break
        case 'return':
          if (s.value) expr(s.value)
          break
        case 'throw':
          expr(s.value)
          break
        case 'while':
          expr(s.cond)
          walkStatements(s.body, locals)
          break
        case 'for-each':
          expr(s.iterable)
          locals.push({
            name: s.item,
            kind: 'local',
            detail: 'iteration item',
            span: s.span,
          })
          walkStatements(s.body, locals)
          break
        case 'if':
          s.branches.forEach(b => {
            expr(b.cond)
            walkStatements(b.body, locals)
          })
          if (s.otherwise) walkStatements(s.otherwise, locals)
          break
        case 'match':
          expr(s.subject)
          s.cases.forEach(c => walkStatements(c.body, locals))
          if (s.otherwise) walkStatements(s.otherwise, locals)
          break
        default:
          break
      }
    }
  }

  for (const statement of program) {
    if (statement.form !== 'function') continue
    const locals: FunctionScope['locals'] = statement.params.map(p => ({
      name: p.name,
      kind: 'parameter' as const,
      detail: showType(p.type ?? { kind: 'unknown' }),
      span: statement.span,
    }))
    walkStatements(statement.body, locals)
    scopes.push({ span: statement.span, locals })
  }

  return { definitions, references, functions, scopes, signatures }
}

// the reference whose span contains the position (the narrowest, for nested calls)
export function referenceAt(
  index: SymbolIndex,
  position: LspPosition,
): Reference | undefined {
  let best: Reference | undefined
  for (const ref of index.references) {
    if (!within(ref.span, position)) continue
    if (!best || size(ref.span) < size(best.span)) best = ref
  }
  return best
}

// every reference (and the definition) of a name, for find-references and rename
export function occurrencesOf(
  index: SymbolIndex,
  name: string,
): Array<Span> {
  const out = index.references
    .filter(r => r.name === name)
    .map(r => r.span)
  const def = index.definitions.get(name)
  if (def) out.push(def.span)
  return out
}

// the names visible at a position: every top-level definition plus the enclosing function's parameters and the
// locals introduced before the cursor
export function scopeAt(
  index: SymbolIndex,
  position: LspPosition,
): Array<Definition> {
  const out: Array<Definition> = [...index.definitions.values()]
  const fn = index.scopes.find(s => within(s.span, position))
  if (fn) {
    for (const local of fn.locals) {
      if (local.kind === 'parameter' || before(local.span, position)) {
        out.push({
          name: local.name,
          kind: local.kind,
          span: local.span,
          detail: local.detail,
        })
      }
    }
  }
  return out
}

// the innermost call enclosing the position, with the active argument index, for signature help
export function callAt(
  program: Program,
  position: LspPosition,
): { name: string; activeParam: number } | undefined {
  let best:
    | { name: string; activeParam: number; span: Span }
    | undefined
  const visit = (node: Expression): void => {
    switch (node.form) {
      case 'call': {
        if (
          within(node.span, position) &&
          node.callee.form === 'variable'
        ) {
          // the active parameter is the count of arguments that begin before the cursor
          const activeParam = Math.max(
            0,
            node.args.filter(a => before(a.span, position)).length -
              (node.args.some(a => within(a.span, position)) ? 1 : 0),
          )
          if (!best || size(node.span) < size(best.span))
            best = {
              name: node.callee.name,
              activeParam,
              span: node.span,
            }
        }
        visit(node.callee)
        node.args.forEach(visit)
        break
      }
      case 'binary':
        visit(node.left)
        visit(node.right)
        break
      case 'unary':
        visit(node.operand)
        break
      case 'member':
        visit(node.target)
        break
      case 'await':
        visit(node.expr)
        break
      case 'array':
        node.items.forEach(visit)
        break
      case 'record':
        node.fields.forEach(f => visit(f.value))
        break
      case 'map':
        node.entries.forEach(e => {
          visit(e.key)
          visit(e.value)
        })
        break
      default:
        break
    }
  }
  const walk = (body: Array<Statement>): void => {
    for (const s of body) {
      switch (s.form) {
        case 'let':
          visit(s.init)
          break
        case 'assign':
          visit(s.target)
          visit(s.value)
          break
        case 'expression':
        case 'hold':
          visit(s.expr)
          break
        case 'return':
          if (s.value) visit(s.value)
          break
        case 'throw':
          visit(s.value)
          break
        case 'while':
          visit(s.cond)
          walk(s.body)
          break
        case 'for-each':
          visit(s.iterable)
          walk(s.body)
          break
        case 'if':
          s.branches.forEach(b => {
            visit(b.cond)
            walk(b.body)
          })
          if (s.otherwise) walk(s.otherwise)
          break
        case 'match':
          visit(s.subject)
          s.cases.forEach(c => walk(c.body))
          if (s.otherwise) walk(s.otherwise)
          break
        case 'function':
          walk(s.body)
          break
        default:
          break
      }
    }
  }
  walk(program)
  return best
    ? { name: best.name, activeParam: best.activeParam }
    : undefined
}

function size(span: Span): number {
  return (
    (span.end.line - span.start.line) * 100000 +
    (span.end.column - span.start.column)
  )
}

// is the position at or after the start of a span (a local is in scope once its declaration has begun)
function before(span: Span, p: LspPosition): boolean {
  return (
    p.line > span.start.line ||
    (p.line === span.start.line && p.character >= span.start.column)
  )
}
