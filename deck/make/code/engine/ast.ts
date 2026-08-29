// The imperative AST for the vibe engine. TypeScript-like constructs. Built as a host DSL for now (a parser comes
// later). Every node is discriminated by `form`. Literals carry raw JS values; the engine turns them into ternary
// data values when it evaluates them.

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
export type UnaryOp = '-' | '!'
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/='

export type Expression =
  | { form: 'integer'; value: number | bigint }
  | { form: 'float'; value: number }
  | { form: 'boolean'; value: boolean }
  | { form: 'string'; value: string }
  // runtime text interpolation: chunks and the expressions between them
  | { form: 'template'; parts: (string | Expression)[] }
  | { form: 'unit' }
  | { form: 'array'; items: Expression[] }
  | { form: 'map'; entries: { key: string; value: Expression }[] }
  | { form: 'variable'; name: string }
  | {
      form: 'binary'
      op: BinaryOp
      left: Expression
      right: Expression
    }
  | { form: 'unary'; op: UnaryOp; operand: Expression }
  | { form: 'call'; callee: Expression; args: Expression[] }
  | { form: 'await'; expr: Expression }
  | { form: 'index'; target: Expression; index: Expression }
  | { form: 'member'; target: Expression; name: string }
  | {
      form: 'closure'
      params: string[]
      body: Statement[]
      isAsync?: boolean
    }

export type Statement =
  | { form: 'let'; name: string; init: Expression; mutable: boolean }
  | {
      form: 'assign'
      target: Expression
      op: AssignOp
      value: Expression
    }
  | { form: 'expression'; expr: Expression }
  | {
      form: 'if'
      branches: { cond: Expression; body: Statement[] }[]
      otherwise?: Statement[]
    }
  | { form: 'while'; cond: Expression; body: Statement[] }
  | {
      form: 'switch'
      subject: Expression
      cases: { match: Expression; body: Statement[] }[]
      otherwise?: Statement[]
    }
  | {
      form: 'function'
      name: string
      params: string[]
      body: Statement[]
      isAsync?: boolean
    }
  | { form: 'return'; value?: Expression }
  | { form: 'break' }
  | { form: 'continue' }
  | { form: 'block'; body: Statement[] }
  | { form: 'throw'; value: Expression }
  | {
      form: 'try'
      body: Statement[]
      catchName?: string
      catchBody?: Statement[]
      finallyBody?: Statement[]
    }
  | {
      form: 'for'
      name: string
      iterable: Expression
      body: Statement[]
    }

export type Program = Statement[]
