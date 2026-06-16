// The compile-time AST: the records the mills mint, carried through resolution and type checking down to codegen.
// Distinct from the engine AST (the runtime interpreter's): these nodes carry a source span, an optional inferred
// type, and may contain holes (unresolved references). See note/research/vibe/computation/plans/11-elaboration.md.

import type { Span } from '@/code/parser/diagnostic'

// surface types. `unknown` is the gradual any. `variable` is an inference metavariable (a type hole).
export type Type =
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'unit' }
  | { kind: 'unknown' }
  | { kind: 'array'; element: Type }
  | { kind: 'named'; name: string }
  | { kind: 'function'; params: Array<Type>; result: Type }
  | { kind: 'variable'; id: number }

export const NUMBER: Type = { kind: 'number' }
export const BOOLEAN: Type = { kind: 'boolean' }
export const STRING: Type = { kind: 'string' }
export const UNIT: Type = { kind: 'unit' }
export const UNKNOWN: Type = { kind: 'unknown' }

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'
export type UnaryOp = '-' | '!'
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/='

export type Binding =
  | { kind: 'parameter' }
  | { kind: 'local' }
  | { kind: 'function'; arity: number }
  | { kind: 'builtin' }
  | { kind: 'deferred' }

export type Expression =
  | { form: 'integer'; value: number | bigint; span: Span; type?: Type }
  | { form: 'float'; value: number; span: Span; type?: Type }
  | { form: 'boolean'; value: boolean; span: Span; type?: Type }
  | { form: 'string'; value: string; span: Span; type?: Type }
  | { form: 'unit'; span: Span; type?: Type }
  | { form: 'variable'; name: string; span: Span; type?: Type; binding?: Binding }
  | { form: 'binary'; op: BinaryOp; left: Expression; right: Expression; span: Span; type?: Type }
  | { form: 'unary'; op: UnaryOp; operand: Expression; span: Span; type?: Type }
  | { form: 'call'; callee: Expression; args: Array<Expression>; span: Span; type?: Type }
  | { form: 'array'; items: Array<Expression>; span: Span; type?: Type }
  | { form: 'map'; entries: Array<{ key: Expression; value: Expression }>; span: Span; type?: Type }
  | { form: 'record'; name: string; fields: Array<{ name: string; value: Expression }>; span: Span; type?: Type }
  | { form: 'member'; target: Expression; name: string; span: Span; type?: Type }
  // a hole: an unresolved reference, may be runtime-deferred
  | { form: 'hole'; name: string; span: Span; type?: Type; deferred?: boolean }

export type Statement =
  | { form: 'let'; name: string; init: Expression; mutable: boolean; span: Span; type?: Type }
  | { form: 'assign'; target: Expression; op: AssignOp; value: Expression; span: Span }
  | { form: 'expression'; expr: Expression; span: Span }
  | { form: 'if'; branches: Array<{ cond: Expression; body: Array<Statement> }>; otherwise?: Array<Statement>; span: Span }
  | { form: 'while'; cond: Expression; body: Array<Statement>; span: Span }
  | { form: 'for-each'; item: string; iterable: Expression; body: Array<Statement>; span: Span }
  | { form: 'break'; span: Span }
  | { form: 'continue'; span: Span }
  | { form: 'return'; value?: Expression; span: Span }
  | { form: 'function'; name: string; params: Array<{ name: string; type?: Type }>; body: Array<Statement>; result?: Type; span: Span }
  | { form: 'record-type'; name: string; params: Array<string>; fields: Array<{ name: string; type: Type }>; span: Span }

export type Program = Array<Statement>

export function showType(type: Type): string {
  switch (type.kind) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'string':
      return 'string'
    case 'unit':
      return 'unit'
    case 'unknown':
      return 'unknown'
    case 'array':
      return `${showType(type.element)}[]`
    case 'named':
      return type.name
    case 'function':
      return `(${type.params.map(showType).join(', ')}) -> ${showType(type.result)}`
    case 'variable':
      return `?${type.id}`
  }
}
