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
  | { kind: 'map'; key: Type; value: Type }
  | { kind: 'named'; name: string; args?: Array<Type> }
  | { kind: 'function'; params: Array<Type>; result: Type; effects?: Array<string> }
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
  // await an async result (`call ... / wait true`)
  | { form: 'await'; expr: Expression; span: Span; type?: Type }
  // a hole: an unresolved reference, may be runtime-deferred
  | { form: 'hole'; name: string; span: Span; type?: Type; deferred?: boolean }

export type Statement =
  | { form: 'let'; name: string; init: Expression; mutable: boolean; span: Span; type?: Type }
  | { form: 'assign'; target: Expression; op: AssignOp; value: Expression; span: Span }
  | { form: 'expression'; expr: Expression; span: Span }
  | { form: 'if'; branches: Array<{ cond: Expression; body: Array<Statement> }>; otherwise?: Array<Statement>; span: Span }
  | { form: 'while'; cond: Expression; body: Array<Statement>; span: Span }
  // a pattern match on an enum value (fork case): each case is a variant label
  | { form: 'match'; subject: Expression; cases: Array<{ label: string; body: Array<Statement> }>; otherwise?: Array<Statement>; span: Span }
  | { form: 'for-each'; item: string; iterable: Expression; body: Array<Statement>; span: Span }
  | { form: 'break'; span: Span }
  | { form: 'continue'; span: Span }
  | { form: 'return'; value?: Expression; span: Span }
  // throw an error value (the `bust` keyword)
  | { form: 'throw'; value: Expression; span: Span }
  // a verification condition: the expression must be provably true (refinement layer 2). An optional `name` makes
  // it a citable lemma; an optional `proof` is the explicit proof tree (heads from hold/base/terms.json).
  | { form: 'hold'; expr: Expression; name?: string; proof?: Array<Proof>; span: Span }
  // a `method` tag marks a function desugared from a form's nested `task`: its `name` is mangled (`<form>_<method>`)
  // to avoid cross-module clashes, and `method` records the form and the bare method name for receiver dispatch.
  | { form: 'function'; name: string; params: Array<{ name: string; type?: Type; refine?: 'natural' }>; body: Array<Statement>; result?: Type; generics: Array<{ name: string; need?: string }>; async?: boolean; method?: { form: string; name: string }; span: Span }
  | { form: 'record-type'; name: string; params: Array<string>; fields: Array<{ name: string; type: Type }>; variants: Array<{ name: string; fields: Array<{ name: string; type: Type }> }>; span: Span }
  // a trait: a named set of method signatures (mask)
  | { form: 'mask'; name: string; methods: Array<string>; span: Span }
  // a trait implementation for a type: provides methods (wear on a form, or suit standalone)
  | { form: 'instance'; mask: string; target: string; methods: Array<string>; span: Span }
  // a native module binding (`dock load / load <node:fs/promises>, name fs`): the env-specific FFI for the stdlib
  | { form: 'native'; alias: string; module: string; span: Span }

// a node in an explicit proof tree: a four-letter tactic `head` paired with an optional one-word `arg`, plus
// nested sub-proofs. See note/research/vibe/computation/libraries/06-hold.md.
export type Proof = { head: string; arg?: string; children: Array<Proof>; span: Span }

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
    case 'map':
      return `map<${showType(type.key)}, ${showType(type.value)}>`
    case 'named':
      return type.args && type.args.length > 0 ? `${type.name}<${type.args.map(showType).join(', ')}>` : type.name
    case 'function': {
      const effects = type.effects && type.effects.length > 0 ? ` !${type.effects.join(',')}` : ''
      return `(${type.params.map(showType).join(', ')}) -> ${showType(type.result)}${effects}`
    }
    case 'variable':
      return `?${type.id}`
  }
}
