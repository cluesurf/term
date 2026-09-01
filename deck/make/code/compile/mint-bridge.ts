// The bridge: the mill executor's minted values (the language's own AST, as one form per grammar rule) into
// the compiler's `Program` (the nodes every later pass reads). This is the half of mill-self-hosting-0006 that
// was never built, opened as its own project: note/term/mint-bridge/readme.md.
//
// WHAT BELONGS HERE. A structural rename, and nothing else. A `task` form becomes a `function` statement, its
// `take` list becomes `params`, its `flow` becomes `body`. If a decision here ever needs to ask "what head word
// was written in the source", that knowledge is in the wrong half: it belongs in the mine grammar, which is the
// only thing allowed to know the surface syntax. The bridge sees shapes, never spellings.
//
// WHAT IT MUST REPRODUCE. Exactly what `compile/mill.ts` produces, including spans, including behaviour that
// looks wrong. Parity has to stay mechanical: the moment the bridge is allowed to fix things while porting,
// every difference becomes an argument instead of a check. Suspicions go in note/term/mint-bridge/quirks.md and
// are fixed after the switch, when there is one implementation left to change.
//
// EVERY minted form is named for the grammar rule that built it, so the switches below are total and a rule
// added to the grammar shows up here as an unhandled name rather than as silence.

import type {
  NameNode,
  Node,
  RootNode,
} from '@term/make/code/parser/tree'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import {
  runMine,
  runMint,
  spanOfWhole,
  wordOf,
  ZERO_SPAN,
} from '@term/make/code/compile/mill-run'
import type {
  Minted,
  MillCapture,
} from '@term/make/code/compile/mill-run'
import { parse } from '@term/make/code/parser/tree'
import {
  readMineGrammar,
  readMintGrammar,
} from '@term/make/code/compile/mill-run'
import type {
  MineGrammar,
  MintGrammar,
} from '@term/make/code/compile/mill-run'
import {
  MINE_SOURCE,
  MINT_SOURCE,
} from '@term/make/code/compile/mill-grammar.generated'
import {
  TYPE_NAME,
  BINARY_BUILTIN,
} from '@term/make/code/compile/surface'
import {
  FREE_UNKNOWN,
  UNKNOWN,
  UNIT,
} from '@term/make/code/compile/node'

export type MillResult =
  | { ok: true; program: Program }
  | { ok: false; diagnostics: Diagnostic[] }

type Form = Extract<Minted, { kind: 'form' }>

// ---- reading a minted value ----

const isForm = (value: Minted | undefined): value is Form =>
  value?.kind === 'form'

function at(value: Minted | undefined, field: string): Minted[] {
  return value?.kind === 'form' ? (value.fields[field] ?? []) : []
}

function firstAt(value: Minted | undefined, field: string): Minted | undefined {
  return at(value, field)[0]
}

function formsAt(value: Minted | undefined, field: string): Form[] {
  return at(value, field).filter(isForm)
}

// `need false` mints as a form carrying the word, not as the word itself
function needWord(value: Minted | undefined): string | undefined {
  const found = firstAt(value, 'need')

  return textOf(found) ?? wordAt(found, 'name')
}

// a `fall <value>` carries its value in a `seed` field, not directly
function fallValue(value: Minted | undefined): Minted | undefined {
  const found = at(value, 'seed')[0]

  return found ?? value
}

// the plain text of a value that is a word or a literal
function textOf(value: Minted | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  return value.kind === 'word' || value.kind === 'text'
    ? value.value
    : value.kind === 'number'
      ? String(value.value)
      : undefined
}

function wordAt(value: Minted | undefined, field: string): string | undefined {
  return textOf(firstAt(value, field))
}

function hasWord(
  value: Minted | undefined,
  field: string,
  word: string,
): boolean {
  return at(value, field).some(
    v => textOf(v) === word || wordAt(v, 'text') === word,
  )
}

const spanOf = (value: Minted | undefined): Span =>
  value?.span ?? (value?.node ? spanOfWhole(value.node) : ZERO_SPAN)

// ---- context ----

type Bridge = {
  file: string
  // the file's role: `site` means every `hook` here is a URL route, `call` means every one is a CLI command
  role?: string
  diagnostics: Diagnostic[]
  // the form a nested `task` belongs to: its methods are mangled `<form>_<name>` and a bare `take self` takes
  // the form's own type
  owner?: string
  // what `self` is typed as inside that form: the form itself, or the primitive / collection it stands for
  selfType?: Type
  // the names already bound in the body being built, so a second `save` of one is an assignment
  declared: Set<string>
  // the owning form's type parameters: every method of the form carries them as leading generics
  ownerParams?: string[]
  // `find X, name Y`: Y is a local synonym for X in this file, rewritten to X across the built program
  aliases: Map<string, string>
}

function unhandled(bridge: Bridge, value: Minted, what: string): undefined {
  bridge.diagnostics.push(
    diagnose('unexpected-node', {
      file: bridge.file,
      span: spanOf(value),
      message: `the mint bridge does not build ${what} yet`,
    }),
  )

  return undefined
}

// ---- types ----

const named = (name: string): Type =>
  TYPE_NAME[name] ?? { kind: 'named', name }

// A `like` names a type and carries its parts: applied arguments ride in the name as a phrase
// (`like stack number`), an element or key/value rides as a nested `like`, and a task type carries its
// parameters as `take` lines plus its result as the nested `like`.
function typeOf(bridge: Bridge, value: Minted | undefined): Type | undefined {
  if (!value) {
    return undefined
  }

  const word = textOf(value)

  if (word !== undefined) {
    return phraseType(word)
  }

  if (!isForm(value)) {
    return undefined
  }

  const phrase = wordAt(value, 'name')

  if (phrase === undefined) {
    return undefined
  }

  const children = at(value, 'child').map(child => typeOf(bridge, child))
  const [head, ...applied] = phrase.split(' ')
  const name = head ?? ''

  // the native collections: their parts are nested `like` lines, and a bare one leaves its part FREE, which is
  // a fresh inference variable rather than the boxed dynamic (a spelled `like unknown` is the dynamic)
  if (name === 'list') {
    return { kind: 'array', element: children[0] ?? FREE_UNKNOWN }
  }

  if (name === 'hash') {
    return {
      kind: 'map',
      key: children[0] ?? FREE_UNKNOWN,
      value: children[1] ?? FREE_UNKNOWN,
    }
  }

  if (name === 'task') {
    const params: Type[] = []
    const paramNames: (string | undefined)[] = []

    for (const take of formsAt(value, 'take')) {
      params.push(typeOf(bridge, firstAt(take, 'like')) ?? UNKNOWN)
      paramNames.push(wordAt(take, 'name'))
    }

    return {
      kind: 'function',
      params,
      result: children[0] ?? UNIT,
      ...(paramNames.some(n => n !== undefined) ? { paramNames } : {}),
    }
  }

  const base = TYPE_NAME[name]

  if (base && applied.length === 0 && children.length === 0) {
    return base
  }

  const args = [
    ...applied.map(phraseType),
    ...children.filter((c): c is Type => c !== undefined),
    // `like maybe / head v`: a `head` child supplies a type argument the way a word chain does
    ...formsAt(value, 'head').map(
      head => typeOf(bridge, firstAt(head, 'like')) ?? named(wordAt(head, 'name') ?? ''),
    ),
  ]

  return {
    kind: 'named',
    name,
    ...(args.length > 0 ? { args } : {}),
  }
}

// A `like task` declares a function type, and its parameters may be written as `take` lines belonging to
// whatever declared the like (the `link` or the enclosing `take`) rather than nested inside the like itself.
// Both spellings mean the same function type.
function withOuterTakes(
  bridge: Bridge,
  declared: Type | undefined,
  owner: Form,
): Type | undefined {
  if (declared?.kind !== 'function' || declared.params.length > 0) {
    return declared
  }

  const takes = formsAt(owner, 'take')

  if (takes.length === 0) {
    return declared
  }

  const params = takes.map(
    take => typeOf(bridge, firstAt(take, 'like')) ?? UNKNOWN,
  )

  // no `paramNames`: the mill records those only when the takes are nested inside the `like` group, and this
  // is the other spelling
  return { ...declared, params }
}

// a type written as one phrase: `stack number` is `stack` applied to `number`
function phraseType(phrase: string): Type {
  const [head, ...applied] = phrase.split(' ')
  const name = head ?? ''

  if (applied.length === 0) {
    return named(name)
  }

  return { kind: 'named', name, args: applied.map(phraseType) }
}

// ---- expressions ----

function expressionOf(
  bridge: Bridge,
  value: Minted | undefined,
): Expression | undefined {
  if (!value) {
    return undefined
  }

  const span = spanOf(value)

  switch (value.kind) {
    case 'text':
      return { form: 'string', value: value.value, span }
    case 'number':
      return value.decimal
        ? { form: 'float', value: value.value, span }
        : { form: 'integer', value: value.value, span }
    case 'word':
      // a bare word in value position is `true`, `false`, or a name
      if (value.value === 'true' || value.value === 'false') {
        return { form: 'boolean', value: value.value === 'true', span }
      }

      return { form: 'variable', name: value.value, span }
    case 'form':
      break
  }

  switch (value.form) {
    case 'seed-loan':
    case 'seed-read':
    case 'read': {
      const path = wordAt(value, 'path') ?? wordAt(value, 'name')

      if (path === undefined) {
        // a bare `read` names the empty path, which is what the reader answers for one
        return readPath('', span)
      }

      // `read x/{key}` reads the member NAMED BY evaluating `key`. The braces are part of one name token, so
      // the segment's expression and its span come from the token's own interpolation part, which is why the
      // capture carries its CST node and not just the rendered word.
      if (path.includes('{')) {
        const dynamic = dynamicPath(value, span)

        if (dynamic) {
          return dynamic
        }
      }

      return readPath(path, span)
    }

    case 'seed-text': {
      const literal = firstAt(value, 'value')

      return {
        form: 'string',
        value: textOf(literal) ?? '',
        // a bare `text` has no literal to take a span from, so the head's own extent stands in
        span: literal ? spanOf(literal) : span,
      }
    }

    case 'seed-code': {
      const literal = firstAt(value, 'value')

      if (literal?.kind === 'number') {
        return literal.decimal
          ? { form: 'float', value: literal.value, span: spanOf(literal) }
          : { form: 'integer', value: literal.value, span: spanOf(literal) }
      }

      // `code false` / `code true`: the boolean written with the literal head
      const word = textOf(literal)

      if (word === 'true' || word === 'false') {
        return { form: 'boolean', value: word === 'true', span: spanOf(literal) }
      }

      return { form: 'integer', value: 0, span }
    }

    case 'seed-term':
      // `term utf8` is the word ITSELF as a value, not a reference to something named `utf8`
      return {
        form: 'string',
        value: wordAt(value, 'name') ?? '',
        span,
      }

    case 'call':
      return callOf(bridge, value)

    case 'make':
      return recordOf(bridge, value)

    case 'task':
      return closureOf(bridge, value)

    case 'fork-test': {
      const built = conditionOf(bridge, value)

      return built?.form === 'if' ? asConditional(built, span) : undefined
    }

    case 'seed-meet': {
      // `meet and` / `meet or` combine their operands with `&&` / `||`, left to right. The marker word says
      // which, and with no operands the identity of that operator is the answer.
      const marker = wordAt(value, 'name') ?? wordAt(value, 'mode')
      const op = marker === 'or' ? ('||' as const) : ('&&' as const)
      const operands = at(value, 'seed')
        .map(operand => expressionOf(bridge, operand))
        .filter((operand): operand is Expression => operand !== undefined)

      if (operands.length === 0) {
        return { form: 'boolean', value: marker !== 'or', span }
      }

      return operands.reduce((left, right) => ({
        form: 'binary',
        op,
        left,
        right,
        span,
      }))
    }

    case 'move': {
      // `move x` hands ownership of `x` on. The value is the same one and the marker is for the checker, but
      // the SPAN is the whole `move x` construct: the mill reads a move exactly as it reads a `read`.
      const moved = wordAt(value, 'name')

      return moved === undefined ? undefined : readPath(moved, span)
    }

    // `bind <name>, <value>` as an argument of the generic call fallback: the value, with the name dropped.
    // At mill time there is no callee signature to place a named argument into, so the reader takes the value
    // and forgets the name, and the built expression is the value's own, span included.
    case 'seed-bind-arg': {
      const bound = firstAt(value, 'seed')

      // a `bind` with no second child has no value to give, and the reader answers unit for it
      return bound
        ? expressionOf(bridge, bound)
        : { form: 'unit', span }
    }

    case 'seed-call-open': {
      // a bare call written as its own head (`name <document>`): the head is the callee, the rest its arguments
      const callee = wordAt(value, 'name')

      // except when the head is a LITERAL keyword: `code false` is the boolean, not a call to `code`
      if (callee === 'code') {
        const word = wordAt(value, 'seed')

        if (word === 'true' || word === 'false') {
          return { form: 'boolean', value: word === 'true', span }
        }
      }

      if (callee === undefined) {
        return unhandled(bridge, value, 'an open call with no head')
      }

      const args: Expression[] = []

      for (const seed of at(value, 'seed')) {
        const built = expressionOf(bridge, seed)

        if (built) {
          args.push(built)
        }
      }

      return {
        form: 'call',
        callee: readPath(callee, span),
        args,
        span,
      }
    }

    default:
      return unhandled(bridge, value, `the ${value.form} expression`)
  }
}

// `make <form>` with `bind` children is a record construction; `make list` / `make hash` with none are the
// native collections, which mill.ts still models as a record of that name.
function recordOf(bridge: Bridge, value: Form): Expression | undefined {
  const name = wordAt(value, 'name')

  if (name === undefined) {
    // a bare `make` is a record with an empty name, which is what the reader answers for one
    return {
      form: 'record',
      name: '',
      fields: [],
      functionFree: true,
      span: spanOf(value),
    }
  }

  const fields: { name: string; value: Expression }[] = []
  const positional: Expression[] = []

  for (const bind of formsAt(value, 'bind')) {
    const built = expressionOf(bridge, firstAt(bind, 'seed'))
    const field = wordAt(bind, 'name')

    if (built && field !== undefined) {
      fields.push({ name: field, value: built })
    }
  }

  for (const seed of at(value, 'seed')) {
    const built = expressionOf(bridge, seed)

    if (built) {
      positional.push(built)
    }
  }

  // `make list` is the native array and `make find` the native map. `make hash` is NOT: it constructs the
  // stdlib's hash FORM, which is a record.
  if (name === 'list' && fields.length === 0) {
    return { form: 'array', items: positional, span: spanOf(value) }
  }

  if (name === 'find') {
    const entries = formsAt(value, 'save').map(entry => ({
      key: {
        form: 'string' as const,
        value: wordAt(entry, 'name') ?? '',
        span: spanOf(value),
      },
      value:
        expressionOf(bridge, firstAt(entry, 'seed')) ??
        ({ form: 'unit' as const, span: spanOf(value) } as Expression),
    }))

    return { form: 'map', entries, span: spanOf(value) }
  }

  const functionFree = fields.every(f => f.value.form !== 'closure')

  return {
    form: 'record',
    name,
    fields,
    ...(positional.length > 0 ? { positional } : {}),
    functionFree,
    span: spanOf(value),
  }
}

// a task written in value position is a closure: the same shape, carried as an expression
function closureOf(bridge: Bridge, value: Form): Expression | undefined {
  const params = formsAt(value, 'take').map(take => {
    const type = typeOf(bridge, firstAt(take, 'like'))

    return {
      name: wordAt(take, 'name') ?? '',
      ...(type ? { type } : {}),
    }
  })
  const result = typeOf(bridge, firstAt(value, 'like'))

  return {
    form: 'closure',
    params,
    body: flowOf(bridge, at(value, 'flow')),
    ...(result ? { result } : {}),
    ...(hasWord(value, 'note', 'async') ? { async: true } : {}),
    span: spanOf(value),
  }
}

// the same branch structure as a statement `if`, carried in value position
function asConditional(
  built: Extract<Statement, { form: 'if' }>,
  span: Span,
): Expression | undefined {
  const branches: { cond: Expression; value: Expression }[] = []

  for (const branch of built.branches) {
    const only = branch.body[0]

    if (branch.body.length !== 1 || only?.form !== 'expression') {
      return undefined
    }

    branches.push({ cond: branch.cond, value: only.expr })
  }

  const last = built.otherwise?.[0]
  const otherwise =
    built.otherwise && built.otherwise.length === 1
      ? last?.form === 'expression'
        ? last.expr
        : // an else-if chain: the else is another conditional, carried in value position too
          last?.form === 'if'
          ? asConditional(last, last.span)
          : undefined
      : undefined

  return {
    form: 'conditional',
    branches,
    ...(otherwise ? { otherwise } : {}),
    span,
  }
}

// the name node a `read` was built from, wherever it sits under the captured group
function nameNodeOf(node: Node | undefined): NameNode | undefined {
  if (!node) {
    return undefined
  }

  if (node.kind === 'name') {
    return node
  }

  if (node.kind !== 'group') {
    return undefined
  }

  for (const child of node.nodes) {
    const found = nameNodeOf(child)

    if (found?.parts.some(part => part.kind === 'interpolation')) {
      return found
    }
  }

  return undefined
}

// A path with an interpolated segment, built from the token's parts the way the mill builds it: each chunk
// contributes plain segments, and each `{...}` contributes a member indexed by the inner group's value.
function dynamicPath(value: Minted, span: Span): Expression | undefined {
  const head = nameNodeOf(value.node)

  if (!head) {
    return undefined
  }

  let built: Expression | undefined

  const step = (name: string): void => {
    built = built
      ? { form: 'member', target: built, name, span }
      : { form: 'variable', name, span }
  }

  for (const part of head.parts) {
    if (part.kind === 'chunk') {
      for (const segment of part.text.split('/').filter(s => s.length > 0)) {
        step(segment)
      }

      continue
    }

    if (!part.group || !built) {
      continue
    }

    const inner = wordOf(part.group)

    built = {
      form: 'member',
      target: built,
      name: '',
      index: {
        form: 'variable',
        name: inner ?? '',
        span: spanOfWhole(part.group),
      },
      span,
    }
  }

  return built
}

// `read a/b/c` is a member chain rooted at a variable; `read x/{k}` is a dynamic index. The path arrives as one
// word because that is how the parser reads it.
function readPath(path: string, span: Span): Expression {
  const parts = path.split('/')
  let node: Expression = {
    form: 'variable',
    name: parts[0] ?? '',
    span,
  }

  for (const part of parts.slice(1)) {
    const dynamic = /^\{(.*)\}$/.exec(part)

    node = dynamic
      ? {
          form: 'member',
          target: node,
          name: '',
          index: { form: 'variable', name: dynamic[1] ?? '', span },
          span,
        }
      : { form: 'member', target: node, name: part, span }
  }

  return node
}

function callOf(bridge: Bridge, value: Form): Expression | undefined {
  const name = wordAt(value, 'name')

  if (name === undefined) {
    return unhandled(bridge, value, 'a call with no name')
  }

  const span = spanOf(value)
  // A call's arguments are matched into two sites, one for `bind <name>, <value>` and one for a bare value,
  // so their interleaving is not in the match. It is in the parse tree: each argument's position among the
  // call's own children IS the order it was written in, and a named argument before a positional one has to
  // stay before it.
  const order = new Map<Node, number>()

  if (value.node?.kind === 'group') {
    value.node.nodes.forEach((child, index) => order.set(child, index))
  }

  const written: {
    at: number
    expr: Expression
    name: string | undefined
  }[] = []

  for (const bind of formsAt(value, 'bind')) {
    const built = expressionOf(bridge, firstAt(bind, 'seed'))

    if (built) {
      written.push({
        at: bind.node ? (order.get(bind.node) ?? written.length) : written.length,
        expr: built,
        name: wordAt(bind, 'name'),
      })
    }
  }

  for (const seed of at(value, 'seed')) {
    const built = expressionOf(bridge, seed)

    if (built) {
      written.push({
        at: seed.node ? (order.get(seed.node) ?? written.length) : written.length,
        expr: built,
        name: undefined,
      })
    }
  }

  // A `note` written under a CALL is not metadata: a call has no metadata, and the mill reads it through the
  // generic path as an argument (`note(async)`). It is a source mistake nothing refuses. Reproduced so parity
  // stays mechanical, and recorded as quirk 6 with the diagnostic it should get instead.
  for (const note of formsAt(value, 'note')) {
    const word = wordAt(note, 'text')

    if (word === undefined) {
      continue
    }

    written.push({
      at: note.node ? (order.get(note.node) ?? written.length) : written.length,
      expr: {
        form: 'call',
        callee: { form: 'variable', name: 'note', span: spanOf(note) },
        args: [
          {
            form: 'variable',
            name: word,
            span: spanOf(firstAt(note, 'text')),
          },
        ],
        span: spanOf(note),
      },
      name: undefined,
    })
  }

  written.sort((a, b) => a.at - b.at)

  const args = written.map(entry => entry.expr)
  const names = written.map(entry => entry.name)

  // the arithmetic and comparison builtins lower to an operator, not a call: they have no definition to bind to
  const folded = foldBuiltin(name, args, span)

  // `halt kink` as a child of the call passes the callee's exception on rather than handling it here
  const propagate = formsAt(value, 'halt').some(
    halt => wordAt(halt, 'mode') === 'kink',
  )
  const call: Expression =
    folded ??
    ({
      form: 'call',
      callee: readPath(name, span),
      args,
      span,
      ...(names.some(Boolean) ? { names } : {}),
      ...(propagate ? { propagate: true } : {}),
    } as Expression)

  return at(value, 'wait').length > 0
    ? { form: 'await', expr: call, span }
    : call
}

function foldBuiltin(
  name: string,
  args: Expression[],
  span: Span,
): Expression | undefined {
  const op = BINARY_BUILTIN[name]

  if (op && args.length === 2) {
    return { form: 'binary', op, left: args[0]!, right: args[1]!, span }
  }

  if (name === 'increment' && args.length === 1) {
    return {
      form: 'binary',
      op: '+',
      left: args[0]!,
      right: { form: 'integer', value: 1, span },
      span,
    }
  }

  if (name === 'decrement' && args.length === 1) {
    return {
      form: 'binary',
      op: '-',
      left: args[0]!,
      right: { form: 'integer', value: 1, span },
      span,
    }
  }

  return undefined
}

// ---- statements ----

function flowOf(bridge: Bridge, values: Minted[]): Statement[] {
  const body: Statement[] = []

  for (let i = 0; i < values.length; i++) {
    const value = values[i]!

    // `note unsafe` over a body, with the `halt take` beside it, is ONE guarded block: the note carries the
    // statements to try and the halt carries the handler and the name it binds the caught exception to.
    if (
      isForm(value) &&
      value.form === 'note' &&
      wordAt(value, 'text') === 'unsafe'
    ) {
      const next = values[i + 1]
      const handler =
        isForm(next) && next.form === 'halt' && wordAt(next, 'mode') === 'take'
          ? next
          : undefined
      const bound = handler ? formsAt(handler, 'take')[0] : undefined

      body.push({
        form: 'guard',
        body: scopedFlow(bridge, at(value, 'flow')),
        ...(handler && bound
          ? {
              catch: {
                name: wordAt(bound, 'name') ?? '',
                body: scopedFlow(bridge, at(handler, 'flow')),
                span: spanOf(handler),
              },
            }
          : {}),
        span: spanOf(value),
      })

      if (handler) {
        i++
      }

      continue
    }

    const built = statementOf(bridge, value)

    if (Array.isArray(built)) {
      body.push(...built)
    } else if (built) {
      body.push(built)
    }
  }

  return body
}

// a nested body is its own scope: a `save x` in one arm of a fork must not turn the `save x` in the other arm
// into an assignment to a name that was never bound on that path
function scopedFlow(bridge: Bridge, values: Minted[]): Statement[] {
  const enclosing = bridge.declared
  bridge.declared = new Set(enclosing)
  const body = flowOf(bridge, values)
  bridge.declared = enclosing

  return body
}

function statementOf(
  bridge: Bridge,
  value: Minted,
): Statement | Statement[] | undefined {
  if (!isForm(value)) {
    // a bare literal as a branch body (`hook hold` over `false`): an expression statement
    const built = expressionOf(bridge, value)

    return built
      ? { form: 'expression', expr: built, span: spanOf(value) }
      : unhandled(bridge, value, 'a bare value as a statement')
  }

  const span = spanOf(value)

  switch (value.form) {
    case 'task':
      return functionOf(bridge, value)

    case 'send': {
      const built = expressionOf(bridge, firstAt(value, 'seed'))

      return {
        form: 'return',
        ...(built ? { value: built } : {}),
        span,
      }
    }

    case 'save': {
      const name = wordAt(value, 'name')
      const init = expressionOf(bridge, firstAt(value, 'seed'))

      if (name === undefined) {
        return unhandled(bridge, value, 'a save with no name')
      }

      if (!init) {
        bridge.declared.add(name)

        return {
          form: 'let',
          name,
          init: { form: 'unit', span },
          mutable: true,
          span,
        }
      }

      // the first `save x` declares; a later one assigns. The language has one word for both, and the
      // difference is whether the name is already in scope. A SLASHED name is never a binding: `save
      // self/count` mutates a member and is always an assignment.
      if (name.includes('/') || bridge.declared.has(name)) {
        // the target carries the STATEMENT's span, the way the mill writes it: `save x, <v>` is one construct
        // and the assignment it lowers to points at the whole of it
        return {
          form: 'assign',
          target: readPath(name, span),
          op: '=',
          value: init,
          span,
        }
      }

      bridge.declared.add(name)
      const declaredType = typeOf(bridge, firstAt(value, 'like'))

      return {
        form: 'let',
        name,
        init,
        mutable: true,
        ...(declaredType ? { type: declaredType } : {}),
        span,
      }
    }

    case 'call': {
      const built = callOf(bridge, value)

      return built ? { form: 'expression', expr: built, span } : undefined
    }

    case 'read':
    case 'seed-read':
    case 'seed-text':
    case 'seed-code':
    case 'seed-term':
    case 'seed-call-open':
    case 'seed-meet': {
      const built = expressionOf(bridge, value)

      return built ? { form: 'expression', expr: built, span } : undefined
    }

    case 'move': {
      // `move x` in statement position: the same value, spanning the whole construct
      const moved = wordAt(value, 'name')

      return moved === undefined
        ? undefined
        : { form: 'expression', expr: readPath(moved, span), span }
    }

    case 'fork-roll': {
      // `fork roll`: a chain of guards, each `hook test` its own branch with an empty body
      const branches = formsAt(value, 'arm').flatMap(arm => {
        const cond = expressionOf(bridge, firstAt(arm, 'flow'))

        return cond ? [{ cond, body: [] as Statement[] }] : []
      })

      return { form: 'if', branches, span }
    }

    case 'roll-def': {
      const name = wordAt(value, 'name')
      const like = wordAt(firstAt(value, 'like'), 'name') ?? wordAt(value, 'like')

      if (name === undefined || like === undefined) {
        return unhandled(bridge, value, 'a roll with no name or kind')
      }

      return { form: 'roll', name, like, span }
    }

    case 'fork-test':
      return conditionOf(bridge, value)

    case 'turn':
      return { form: 'continue', span }

    case 'halt':
      return haltOf(bridge, value)

    case 'free':
      // `free x` releases a binding: it declares nothing and emits nothing
      return undefined

    case 'make': {
      const built = recordOf(bridge, value)

      return built ? { form: 'expression', expr: built, span } : undefined
    }

    case 'walk':
      return loopOf(bridge, value)

    case 'fork-case':
      return matchOf(bridge, value)

    case 'host':
      return constantOf(bridge, value)

    default:
      return unhandled(bridge, value, `the ${value.form} statement`)
  }
}

// `halt` is the one word for stopping a flow. A bare `halt` breaks a loop, `halt flow` ends the program,
// `halt code` is a breakpoint, and anything else raises.
function haltOf(bridge: Bridge, value: Form): Statement | undefined {
  const span = spanOf(value)
  const mode = wordAt(value, 'mode')

  if (mode === undefined) {
    const raised = expressionOf(bridge, firstAt(value, 'seed'))

    return raised
      ? { form: 'throw', value: raised, span }
      : { form: 'break', span }
  }

  switch (mode) {
    case 'flow':
      return { form: 'exit', span }
    case 'code':
      return { form: 'debug', span }
    case 'kink':
      // `halt kink` propagates a callee's exception; as a statement it raises what it was given
      return { form: 'break', span }
    default:
      break
  }

  // `halt <form>` with `bind` children RAISES that exception: the value is the form constructed from the
  // binds, and `raise` names it so extendForms can check it is an exception and fill the carrier's fields.
  const binds = formsAt(value, 'bind')

  if (binds.length > 0) {
    const fields = binds.flatMap(bind => {
      const built = expressionOf(bridge, firstAt(bind, 'seed'))
      const field = wordAt(bind, 'name')

      return built && field !== undefined
        ? [{ name: field, value: built }]
        : []
    })

    return {
      form: 'throw',
      // no `functionFree` here: the mill sets that flag on a `make` construction and not on a raise
      value: {
        form: 'record',
        name: mode,
        fields,
        span,
      },
      raise: mode,
      span,
    }
  }

  const raised = expressionOf(bridge, firstAt(value, 'seed'))

  return {
    form: 'throw',
    value: raised ?? { form: 'string', value: mode, span },
    raise: mode,
    span,
  }
}

// `walk list, <seq>` iterates; `walk test` loops while a condition holds. Both arrive as one `walk` form
// distinguished by its mode word, which is the only thing that tells them apart.
function loopOf(
  bridge: Bridge,
  value: Form,
): Statement | Statement[] | undefined {
  const span = spanOf(value)
  const mode = wordAt(value, 'mode')
  const hooks = formsAt(value, 'hook')

  if (mode === 'list') {
    const iterable = expressionOf(bridge, firstAt(value, 'seed'))
    const next = hooks.find(h => wordAt(h, 'name') === 'next') ?? hooks[0]

    if (!iterable || !next) {
      return unhandled(bridge, value, 'a walk with no sequence')
    }

    // `take site, name item` names the loop variable in its alias
    const binder = formsAt(next, 'take')[0]
    const item =
      wordAt(firstAt(binder, 'alias'), 'name') ??
      textOf(firstAt(binder, 'alias')) ??
      wordAt(binder, 'name') ??
      ''

    return {
      form: 'for-each',
      item,
      iterable,
      body: scopedFlow(bridge, at(next, 'flow')),
      span,
    }
  }

  if (mode === 'test') {
    const test = hooks.find(h => wordAt(h, 'name') === 'test')
    const step = hooks.find(h => {
      const name = wordAt(h, 'name')

      return name === 'step' || name === 'hold'
    })
    // `walk test` with no `hook test` has no condition: the mill writes `false`, so the loop never runs. That
    // is a source mistake rather than a spelling, and the mill's answer is the one to reproduce.
    const cond = expressionOf(bridge, firstAt(test, 'flow')) ?? {
      form: 'boolean' as const,
      value: false,
      span,
    }

    return {
      form: 'while',
      cond,
      body: step ? scopedFlow(bridge, at(step, 'flow')) : [],
      span,
    }
  }

  if (mode === 'size') {
    // a counted walk: `bind base` and `bind head` bound the counter, and the loop is the count written out
    const binds = formsAt(value, 'bind')
    const boundOf = (name: string): Expression | undefined =>
      expressionOf(
        bridge,
        firstAt(
          binds.find(bind => wordAt(bind, 'name') === name),
          'seed',
        ),
      )
    const from = boundOf('base') ?? { form: 'integer', value: 0, span }
    const to = boundOf('head')
    const next = hooks.find(h => wordAt(h, 'name') === 'next') ?? hooks[0]
    const binder = formsAt(next, 'take')[0]
    const item =
      wordAt(firstAt(binder, 'alias'), 'name') ??
      textOf(firstAt(binder, 'alias')) ??
      wordAt(binder, 'name') ??
      'i'

    if (!to || !next) {
      return unhandled(bridge, value, 'a walk size with no bound')
    }

    const counter: Expression = { form: 'variable', name: item, span }

    return [
      { form: 'let', name: item, init: from, mutable: true, span },
      {
      form: 'while',
      cond: { form: 'binary', op: '<', left: counter, right: to, span },
      body: [
        ...scopedFlow(bridge, at(next, 'flow')),
        {
          form: 'assign',
          target: counter,
          op: '=',
          value: {
            form: 'binary',
            op: '+',
            left: counter,
            right: { form: 'integer', value: 1, span },
            span,
          },
          span,
        },
      ],
      span,
      },
    ]
  }

  // any other mode is one the mill has no lowering for: it writes a loop that never runs, and so does this
  return { form: 'while', cond: { form: 'boolean', value: false, span }, body: [], span }
}

// `fork case, <subject>` with one `case <label>` arm per variant
function matchOf(bridge: Bridge, value: Form): Statement | undefined {
  const span = spanOf(value)
  const subject = expressionOf(bridge, firstAt(value, 'seed'))

  if (!subject) {
    return unhandled(bridge, value, 'a fork case with no subject')
  }

  const cases: { label: string; body: Statement[]; binds?: string[] }[] = []
  let otherwise: Statement[] | undefined

  for (const arm of formsAt(value, 'arm')) {
    const label = wordAt(arm, 'name')
    const body = scopedFlow(bridge, at(arm, 'flow'))

    if (label === undefined) {
      otherwise = body
      continue
    }

    // a leading run of `link <name>` lines selects or renames the variant's fields
    const binds = at(arm, 'link')
      .map(link => wordAt(link, 'name') ?? textOf(link) ?? '')
      .filter(Boolean)

    cases.push({
      label,
      body,
      ...(binds.length > 0 ? { binds } : {}),
    })
  }

  return {
    form: 'match',
    subject,
    cases,
    ...(otherwise ? { otherwise } : {}),
    span,
  }
}

// `host x, <value>` is a constant. A value-less `host` with a foreign `name <X>` is an ambient host global.
function constantOf(bridge: Bridge, value: Form): Statement | undefined {
  const span = spanOf(value)
  const name = wordAt(value, 'name')

  if (name === undefined) {
    return unhandled(bridge, value, 'a host with no name')
  }

  const seed = firstAt(value, 'seed')
  const type = typeOf(bridge, firstAt(value, 'like'))

  // `host document, name <document>`: the seed is the foreign-name annotation, not a value
  if (
    isForm(seed) &&
    seed.form === 'seed-call-open' &&
    wordAt(seed, 'name') === 'name'
  ) {
    return {
      form: 'let',
      name,
      init: { form: 'unit', span },
      mutable: false,
      foreign: wordAt(seed, 'seed') ?? name,
      ...(type ? { type } : {}),
      span,
    }
  }

  // A `host` whose children are more `host` lines is an anonymous record: a constant written as a little tree.
  // A `host` carrying SEVERAL values is a list, one entry per value: md5's sine table and the AES S-box are
  // written that way, and reading only the first is how the md5 table shipped as a single number.
  const nested = formsAt(value, 'host')
  const seeds = at(value, 'seed')
  const values = seeds
    .map(entry => expressionOf(bridge, entry))
    .filter((entry): entry is Expression => entry !== undefined)
  const init =
    nested.length > 0
      ? anonymousRecord(bridge, nested, span)
      : values.length > 1
        ? ({ form: 'array', items: values, span } as Expression)
        : (values[0] ?? { form: 'unit' as const, span })

  // With no `like`, the constant's type is the one its LITERAL names: an integer literal is `integer`, a
  // decimal `number`, a text `text`, a boolean `boolean`. Anything else is left to inference.
  const literalType: Type | undefined =
    init.form === 'integer'
      ? { kind: 'named', name: 'integer' }
      : init.form === 'float'
        ? { kind: 'named', name: 'number' }
        : init.form === 'string'
          ? { kind: 'named', name: 'text' }
          : init.form === 'boolean'
            ? { kind: 'named', name: 'boolean' }
            : undefined

  return {
    form: 'let',
    name,
    init,
    mutable: false,
    ...(type ?? literalType ? { type: type ?? literalType } : {}),
    span,
  }
}

// the record a nested `host` block builds. It has no form name: the compiler synthesizes one per record when
// a backend needs a struct for it.
function anonymousRecord(
  bridge: Bridge,
  entries: Form[],
  span: Span,
): Expression {
  const fields = entries.map(entry => {
    const inner = formsAt(entry, 'host')

    return {
      name: wordAt(entry, 'name') ?? '',
      value:
        inner.length > 0
          ? anonymousRecord(bridge, inner, spanOf(entry))
          : (expressionOf(bridge, firstAt(entry, 'seed')) ?? {
              form: 'unit' as const,
              span: spanOf(entry),
            }),
    }
  })

  // no `functionFree` here: the mill sets that flag on a `make` construction and not on a host record, and
  // parity is what this file is for
  return {
    form: 'record',
    name: '',
    fields,
    span,
  }
}

// `fork test` with `hook test` / `hook hold` / `hook miss` arms. The arms arrive in source order, each carrying
// the word that names it, so a chain of test/hold pairs becomes an if / else-if chain and a `miss` becomes the
// else.
function conditionOf(
  bridge: Bridge,
  value: Form,
): Statement | undefined {
  const span = spanOf(value)
  const branches: { cond: Expression; body: Statement[] }[] = []
  let otherwise: Statement[] | undefined
  let pending: Expression | undefined

  // `fork test, name <flag>` dispatches on a named boolean parameter: the condition is a read of that flag.
  // `fork test, <expression>` writes the condition inline. Either way it is the condition the first `hook
  // hold` holds on.
  const flag = wordAt(firstAt(value, 'name'), 'name')
  const inline = flag
    ? ({ form: 'variable', name: flag, span } as Expression)
    : expressionOf(bridge, firstAt(value, 'condition'))

  if (inline) {
    pending = inline
  }

  for (const arm of formsAt(value, 'arm')) {
    const kind = wordAt(arm, 'kind')
    const flow = at(arm, 'flow')

    if (kind === 'test') {
      pending = expressionOf(bridge, flow[0])
      continue
    }

    if (kind === 'hold' || kind === 'step') {
      // a `hook hold` with nothing to hold on is unconditional: its body is what runs, which is the else
      if (!pending) {
        otherwise = scopedFlow(bridge, flow)
        continue
      }

      branches.push({ cond: pending, body: scopedFlow(bridge, flow) })
      pending = undefined
      continue
    }

    if (kind === 'miss' || kind === 'else' || kind === 'fall') {
      otherwise = scopedFlow(bridge, flow)
      continue
    }

    return unhandled(bridge, arm, `a fork arm named ${kind ?? '(nothing)'}`)
  }

  // a `hook test` with no `hook hold` after it is still a branch: its body is empty and the work is in the
  // `hook miss`. Dropping the condition would drop the test itself.
  if (pending) {
    branches.push({ cond: pending, body: [] })
  }

  return {
    form: 'if',
    branches,
    ...(otherwise ? { otherwise } : {}),
    span,
  }
}

// one `take` line: its name, declared type, `need false` (optional) and `fall <value>` (default)
function paramOf(
  bridge: Bridge,
  take: Form,
  owner: string | undefined,
): {
  name: string
  type?: Type
  refine?: 'natural'
  optional?: boolean
  fallback?: Expression
  positional?: boolean
} {
  const name = wordAt(take, 'name') ?? ''
  const declared = withOuterTakes(
    bridge,
    typeOf(bridge, firstAt(take, 'like')),
    take,
  )
  // a form's method takes its own form as `self` when nothing else is written
  const type =
    declared ?? (owner && name === 'self' ? bridge.selfType : undefined)
  const like = firstAt(take, 'like')
  const need = needWord(take) ?? needWord(like)
  const fallback = expressionOf(
    bridge,
    fallValue(firstAt(take, 'fall') ?? firstAt(like, 'fall')),
  )

  // a parameter with a default is optional too: the caller may leave it out either way
  const optional = need === 'false' || Boolean(fallback)
  // `like natural-number` refines the number to the naturals
  const refine = wordAt(like, 'name') === 'natural-number'

  return {
    name,
    ...(type ? { type } : {}),
    ...(refine ? { refine: 'natural' as const } : {}),
    ...(optional ? { optional: true } : {}),
    ...(fallback ? { fallback } : {}),
  }
}

function functionOf(bridge: Bridge, value: Form): Statement | undefined {
  const bare = wordAt(value, 'name')

  if (bare === undefined) {
    // a top-level `task` with no name builds nothing: the reader's `buildFunction` answers undefined for one,
    // and the program gets no statement rather than a diagnostic
    return undefined
  }

  const owner = bridge.owner
  const name = owner ? `${owner}_${bare}` : bare
  const params = formsAt(value, 'take').map(take =>
    paramOf(bridge, take, owner),
  )

  // A `free x, like T` inside the body supplies the TASK's result type when the task declares none. That is
  // what the mill does and it looks wrong (a `free` forward-declares a binding, it is not a return annotation),
  // so it is reproduced here and written down: note/term/mint-bridge/quirks.md entry 3.
  const freed = at(value, 'flow')
    .filter(isForm)
    .find(step => step.form === 'free' && firstAt(step, 'like'))
  const result =
    typeOf(bridge, firstAt(value, 'like')) ??
    (freed ? typeOf(bridge, firstAt(freed, 'like')) : undefined)
  // a function body is its own scope: a `save` inside it declares, whatever the enclosing body has bound
  const enclosing = bridge.declared
  bridge.declared = new Set(params.map(p => p.name))
  // `task read-synchronously, name <read-file>` annotates the task with the host name it maps to. The comma
  // leaves it where a body statement would sit, and it is not one: the mill emits an empty body here.
  // `note unsafe` over a body is captured at the task's own `note` site, not in its flow, while the `halt take`
  // that handles it IS in the flow. Put the note back in front of the flow so the two pair into one guard.
  const guardNote = formsAt(value, 'note').find(
    note => wordAt(note, 'text') === 'unsafe' && at(note, 'flow').length > 0,
  )
  const steps = at(value, 'flow').filter(
    step =>
      !(
        isForm(step) &&
        step.form === 'seed-call-open' &&
        wordAt(step, 'name') === 'name'
      ),
  )
  const body = flowOf(
    bridge,
    guardNote ? [guardNote, ...steps] : steps,
  )
  bridge.declared = enclosing

  const generics = [
    ...(bridge.ownerParams ?? []).map(p => ({ name: p })),
    ...formsAt(value, 'head').map(head => {
      const need = wordAt(head, 'need')

      return {
        name: wordAt(head, 'name') ?? '',
        ...(need !== undefined ? { need } : {}),
      }
    }),
  ]

  return {
    form: 'function',
    name,
    params,
    body,
    ...(result ? { result } : {}),
    generics,
    ...(hasWord(value, 'note', 'async') ? { async: true } : {}),
    ...(hasWord(value, 'note', 'private') ? { private: true } : {}),
    ...(owner ? { method: { form: owner, name: bare } } : {}),
    span: spanOf(value),
  }
}

// A top-level statement can lower to several compiler statements (a form and its methods), or to none at all
// (a `load` is an import, which the loader resolves; it is not part of the program).
function topLevelOf(bridge: Bridge, value: Minted): Statement[] {
  if (!isForm(value)) {
    return asStatements(statementOf(bridge, value))
  }

  switch (value.form) {
    case 'load':
      // The loader resolves the path; the only thing to keep here is `find X, name Y`, which makes Y a local
      // synonym for X in this file. Every reference to Y is rewritten to X once the program is built.
      for (const found of formsAt(value, 'find')) {
        const imported = wordAt(found, 'text')
        const local = wordAt(firstAt(found, 'name'), 'name') ?? wordAt(found, 'name')

        if (imported && local && local !== imported) {
          bridge.aliases.set(local, imported)
        }
      }

      return []

    case 'bear':
      // imports are resolved by the module loader and carry no statement
      return []

    case 'form':
      return formOf(bridge, value)

    // a top-level `note` is documentation, and `note draft` shelves the file. Neither is a statement, and the
    // reader drops both.
    case 'note':
      return []

    case 'dock-bind':
      return nativeOf(bridge, value)

    case 'mask': {
      const name = wordAt(value, 'name')

      if (name === undefined) {
        unhandled(bridge, value, 'a mask with no name')

        return []
      }

      return [
        {
          form: 'mask',
          name,
          methods: formsAt(value, 'task')
            .map(task => wordAt(task, 'name') ?? '')
            .filter(Boolean),
          span: spanOf(value),
        },
      ]
    }

    case 'suit': {
      // `suit <target>` declares nothing itself: its `wear` blocks are trait implementations for the target
      const target = wordAt(value, 'name')

      if (target === undefined) {
        return []
      }

      return formsAt(value, 'wear').flatMap(worn => {
        const mask = wordAt(worn, 'name')

        return mask === undefined
          ? []
          : [
              {
                form: 'instance' as const,
                mask,
                target,
                methods: formsAt(worn, 'task')
                  .map(task => wordAt(task, 'name') ?? '')
                  .filter(Boolean),
                span: spanOf(worn),
              },
            ]
      })
    }

    case 'wear': {
      const mask = wordAt(value, 'name')

      if (mask === undefined || !bridge.owner) {
        return []
      }

      return [
        {
          form: 'instance',
          mask,
          target: bridge.owner,
          methods: formsAt(value, 'task')
            .map(task => wordAt(task, 'name') ?? '')
            .filter(Boolean),
          span: spanOf(value),
        },
      ]
    }

    case 'bind-def':
      return bindOf(bridge, value)

    case 'hook':
      // a top-level `hook` is the CLI command / route DSL: one dock statement carrying the whole tree
      return [
        {
          form: 'dock',
          route: routeOf(bridge, value),
          span: spanOf(value),
        },
      ]

    case 'rule-def': {
      const name = wordAt(value, 'name')

      if (name === undefined) {
        return []
      }

      const params = formsAt(value, 'mark').map(mark => {
        const type = typeOf(bridge, firstAt(mark, 'like'))

        return {
          name: wordAt(mark, 'name') ?? '',
          ...(type ? { type } : {}),
        }
      })
      const claim = expressionOf(bridge, firstAt(value, 'seed'))
      const result = typeOf(bridge, firstAt(value, 'like'))

      return [
        {
          form: 'function',
          name,
          params,
          body: claim
            ? [{ form: 'return' as const, value: claim, span: spanOf(value) }]
            : [],
          ...(result ? { result } : {}),
          generics: [],
          span: spanOf(value),
        },
      ]
    }

    default:
      return asStatements(statementOf(bridge, value))
  }
}

// a statement builder may answer with none, one, or several (a counted walk is a counter plus its loop)
function asStatements(
  built: Statement | Statement[] | undefined,
): Statement[] {
  return Array.isArray(built) ? built : built ? [built] : []
}

// The help text a `#` comment above a command or a parameter carries. Comments are CST trivia the parser
// attaches to the group, and a minted value keeps its CST node, so they survive the mill without the grammar
// having to say anything about them. Multi-line comments join with a space, so a wrapped sentence stays one
// help line.
function leadingNote(value: Minted | undefined): string | undefined {
  const node = value?.node

  if (node?.kind !== 'group' || !node.comments) {
    return undefined
  }

  const text = node.comments
    .map(comment => comment.text.replace(/^#\s?/, '').trim())
    .filter(line => line.length > 0)
    .join(' ')

  return text.length > 0 ? text : undefined
}

// One `hook`: a CLI command or a URL route, with its help text, its parameters, the task it runs and its
// subcommands. Nested hooks are its children, so a command group is one dock statement, not several.
function routeOf(
  bridge: Bridge,
  value: Form,
): Extract<Statement, { form: 'dock' }>['route'] {
  // `take path` / `take query` / `take body` / `take head` are SECTIONS, not parameters: they group the
  // route's real takes by where they come from, and the takes are the ones nested inside them.
  const SECTION = new Set(['path', 'query', 'body', 'head'])
  const takeList = formsAt(value, 'take').flatMap(take =>
    SECTION.has(wordAt(take, 'name') ?? '') ? formsAt(take, 'take') : [take],
  )
  const takes = takeList.map(take => {
    const type = typeOf(bridge, firstAt(take, 'like'))
    const note = leadingNote(take) ?? wordAt(firstAt(take, 'note'), 'text')
    const short = wordAt(take, 'code')
    const fallbackValue = firstAt(
      formsAt(take, 'bind')[0],
      'seed',
    )
    const literal = fallbackValue
      ? (expressionOf(bridge, fallbackValue) ?? undefined)
      : undefined
    const fallback =
      literal?.form === 'integer' || literal?.form === 'float'
        ? Number(literal.value)
        : literal?.form === 'string'
          ? literal.value
          : literal?.form === 'boolean'
            ? literal.value
            : undefined

    return {
      name: wordAt(take, 'name') ?? '',
      ...(type ? { type } : {}),
      required: needWord(take) === 'true',
      ...(short !== undefined ? { short } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      ...(at(take, 'many').length > 0 ? { variadic: true } : {}),
      span: spanOf(take),
    }
  })

  // `hook` spells two things. A ROUTE (role `site`, or a path, or a component) carries a component and no help
  // text; a CLI COMMAND carries help text and the task it runs. Telling them apart from content alone was the
  // guess role.tree exists to end, so the role decides first.
  const path = wordAt(value, 'name') ?? ''
  const isRoute =
    bridge.role === 'site' ||
    (bridge.role !== 'call' &&
      (path.startsWith('/') || formsAt(value, 'view').length > 0))
  const help = isRoute
    ? undefined
    : (leadingNote(value) ?? wordAt(firstAt(value, 'note'), 'text'))

  // the implementation, in either spelling: `task <impl>` names the handler and passes the takes in order,
  // `call <impl>` names it with its arguments written out
  const argsOf = (
    call: Form,
  ): { name: string; value: Expression }[] =>
    formsAt(call, 'bind').flatMap(bind => {
      const built = expressionOf(bridge, firstAt(bind, 'seed'))
      const name = wordAt(bind, 'name')

      return built && name !== undefined ? [{ name, value: built }] : []
    })
  // a `call` written under a hook is captured with the rest of its flow
  const flowCalls = at(value, 'flow')
    .filter(isForm)
    .filter(step => step.form === 'call')
    .map(call => ({
      name: wordAt(call, 'name') ?? '',
      args: argsOf(call),
      span: spanOf(call),
    }))

  // A ROUTE's `task get` / `task post` are its HTTP METHODS, each with its own takes, calls and responses.
  // A command's `task <impl>` is its handler instead, which is why the two shapes are told apart first.
  const methods = isRoute
    ? formsAt(value, 'task').map(method => ({
        name: wordAt(method, 'name') ?? '',
        takes: formsAt(method, 'take')
          .flatMap(take =>
            SECTION.has(wordAt(take, 'name') ?? '')
              ? formsAt(take, 'take')
              : [take],
          )
          .map(take => {
            const type = typeOf(bridge, firstAt(take, 'like'))

            return {
              name: wordAt(take, 'name') ?? '',
              ...(type ? { type } : {}),
              required: needWord(take) === 'true',
              span: spanOf(take),
            }
          }),
        calls: at(method, 'flow')
          .filter(isForm)
          .filter(step => step.form === 'call')
          .map(call => ({
            name: wordAt(call, 'name') ?? '',
            args: argsOf(call),
            span: spanOf(call),
          })),
        sends: at(method, 'flow')
          .filter(isForm)
          .filter(step => step.form === 'send-kind')
          .map(send => {
            const built = expressionOf(bridge, firstAt(send, 'seed'))

            return {
              name: wordAt(send, 'kind') ?? '',
              ...(built ? { value: built } : {}),
            }
          }),
        span: spanOf(method),
      }))
    : []

  const calls = [
    // `task <impl>` binds a COMMAND's handler and passes its takes in order. A route has no such spelling.
    ...(isRoute
      ? []
      : formsAt(value, 'task').map(task => ({
          name: wordAt(task, 'name') ?? '',
          args: [],
          span: spanOf(task),
        }))),
    ...formsAt(value, 'call').map(call => ({
      name: wordAt(call, 'name') ?? '',
      args: argsOf(call),
      span: spanOf(call),
    })),
    ...flowCalls,
  ]

  // a client route renders a component, with its props
  const shown = formsAt(value, 'view')[0]
  const component = shown
    ? {
        name: wordAt(shown, 'name') ?? '',
        props: formsAt(shown, 'bind').flatMap(bind => {
          const built = expressionOf(bridge, firstAt(bind, 'seed'))
          const name = wordAt(bind, 'name')

          return built && name !== undefined ? [{ name, value: built }] : []
        }),
      }
    : undefined

  return {
    path,
    ...(help !== undefined ? { note: help } : {}),
    takes,
    methods,
    calls,
    ...(component ? { component } : {}),
    directives: [],
    sends: [],
    hooks: [],
    children: formsAt(value, 'hook').map(child => routeOf(bridge, child)),
    span: spanOf(value),
  }
}

// A declarative native binding: one stdlib name, one native expression per environment.
function bindOf(bridge: Bridge, value: Form): Statement[] {
  const name = wordAt(value, 'name')

  if (name === undefined) {
    unhandled(bridge, value, 'a bind with no name')

    return []
  }

  const params = formsAt(value, 'take').map(take => {
    const type = typeOf(bridge, firstAt(take, 'like'))

    return {
      name: wordAt(take, 'name') ?? '',
      ...(type ? { type } : {}),
    }
  })
  const result = typeOf(bridge, firstAt(value, 'like'))
  // A target's children are its native expression and the imports that expression needs, in whatever order
  // they were written: the `text <...>` is the expression, and each `load <...>` beside it is an import.
  const targets = formsAt(value, 'case').map(target => {
    const seeds = formsAt(target, 'seed')
    const written = seeds.find(seed => seed.form === 'seed-text')
    const loads = seeds.filter(
      seed => seed.form === 'seed-call-open' && wordAt(seed, 'name') === 'load',
    )

    return {
      env: wordAt(target, 'platform') ?? '',
      expression:
        wordAt(written, 'value') ?? wordAt(target, 'text') ?? '',
      imports: [
        ...loads.map(load => ({ module: wordAt(load, 'seed') ?? '' })),
        ...at(target, 'load')
          .map(load => ({ module: textOf(load) ?? '' }))
          .filter(entry => entry.module !== ''),
      ].filter(entry => entry.module !== ''),
    }
  })

  return [
    {
      form: 'bind',
      name,
      params,
      ...(result ? { result } : {}),
      targets,
      span: spanOf(value),
    },
  ]
}

// `dock load` binds a native module, `dock type` an opaque per-backend handle type. One statement per line.
function nativeOf(bridge: Bridge, value: Form): Statement[] {
  const kind = wordAt(value, 'kind')

  return formsAt(value, 'line').flatMap(line => {
    const module = wordAt(line, 'path')
    const alias = wordAt(line, 'name')

    // a line with no alias binds nothing and is skipped, the way the mill skips it
    if (module === undefined || alias === undefined) {
      return []
    }

    return [
      {
        form: 'native' as const,
        alias,
        module,
        kind: kind === 'type' ? ('type' as const) : ('module' as const),
        // the span is the LOAD line, not the whole dock block: each line is its own statement
        span: spanOf(line),
        file: bridge.file,
      },
    ]
  })
}

// One `link` line of a form: its name and type. The type is written `like <t>`, or in one of the shorthands
// that name a collection of a form (`list <t>`). `need false` makes the field optional, and the comma rule
// leaves it inside the `like` group, which is where the grammar captures it.
function fieldOf(
  bridge: Bridge,
  link: Form,
): {
  name: string
  type: Type
  identity: boolean
  nick?: string
  optional?: boolean
  fallback?: Expression
} {
  const like = firstAt(link, 'like')
  const listOf = firstAt(link, 'list')
  const declared = withOuterTakes(bridge, typeOf(bridge, like), link)
  const element = wordAt(listOf, 'form')
  const type: Type =
    declared ??
    (element !== undefined
      ? { kind: 'array', element: named(element) }
      : UNKNOWN)
  const need = needWord(link) ?? needWord(like)
  const fallback = expressionOf(
    bridge,
    fallValue(firstAt(link, 'fall') ?? firstAt(like, 'fall')),
  )

  // `name <onabort>`: the field's exact native spelling, so an emitter writes the host's own name instead of
  // camel-casing the Term one. Every field in @term/bind carries one.
  //
  // A field CALLED `name` gets none. `compile/mill.ts` finds the spelling by scanning the link's children for
  // the first one headed `name`, and for `link name, name <name>` that is the field's own name, whose value is
  // not a text, so the scan stops there and the annotation is never reached. This is the one place the bridge
  // reads a spelling rather than a shape, because the quirk is ABOUT a spelling and cannot be said in a
  // grammar that matches children in order. It goes when quirk 6 is fixed.
  const field = wordAt(link, 'name')
  const nick = field === 'name' ? undefined : wordAt(link, 'nick')

  return {
    name: field ?? '',
    type,
    identity: false,
    ...(nick !== undefined ? { nick } : {}),
    ...(need === 'false' || fallback ? { optional: true } : {}),
    ...(fallback ? { fallback } : {}),
  }
}

// A `form` declares a type and, nested inside it, that type's methods. mill.ts emits the methods as ordinary
// top-level functions carrying a `method` tag, so they are lifted out here the same way.
function formOf(bridge: Bridge, value: Form): Statement[] {
  const name = wordAt(value, 'name')

  if (name === undefined) {
    unhandled(bridge, value, 'a form with no name')

    return []
  }

  const out: Statement[] = []
  // `head a` names a TYPE parameter. `head b, like <type>` names a VALUE index: it makes this an indexed
  // family, where `sigma a (b: a -> type)` is a different type for a different `b`.
  const heads = formsAt(value, 'head')
  const params = heads
    .filter(head => !firstAt(head, 'like'))
    .map(head => wordAt(head, 'name') ?? '')
    .filter(Boolean)
  const indices = heads.flatMap(head => {
    const type = typeOf(bridge, firstAt(head, 'like'))

    return type ? [{ name: wordAt(head, 'name') ?? '', type }] : []
  })

  // A form NAMED for a primitive registers no record-type: the compiler uses the native representation, and a
  // record-type of that name would clash with it. Its methods are still desugared, typed over the primitive.
  const primitive = TYPE_NAME[name]
  const self: Type | undefined = primitive
    ? primitive
    : name === 'list'
      ? { kind: 'array', element: { kind: 'named', name: params[0] ?? 't' } }
      : name === 'hash'
        ? {
            kind: 'map',
            key: { kind: 'named', name: params[0] ?? 'k' },
            value: { kind: 'named', name: params[1] ?? 'v' },
          }
        : undefined

  if (!self) {
    const fields = formsAt(value, 'link').map(link => fieldOf(bridge, link))
    // `like <base>` on a form: with children it EXTENDS the base (`bind` pins one of its fields, `link` adds a
    // prop, `head` names a type argument), and with none it is a transparent ALIAS of it
    const like = firstAt(value, 'like')
    const base = typeOf(bridge, like)
    const pins = formsAt(like, 'bind').map(pin => ({
      name: wordAt(pin, 'name') ?? '',
      value:
        expressionOf(bridge, firstAt(pin, 'seed')) ??
        ({
          form: 'string' as const,
          value: wordAt(pin, 'text') ?? '',
          span: spanOf(pin),
        }),
    }))
    const links = formsAt(like, 'link').map(link => fieldOf(bridge, link))
    // Only a `head` that carries a `like` or a `link` of its own counts. A bare `head t` under the base is a
    // positional type ARGUMENT (`like list / head text`), and `head t / base function` in the binding files is
    // a bound, and neither makes the form an extension of its base: `form class-decorator / like task /
    // head t-function / base function` is an ALIAS for a function type. Counting them turned every one of
    // those into an extension of `task` with an empty body.
    const heads = formsAt(like, 'head')
      .filter(head => firstAt(head, 'like') || at(head, 'link').length > 0)
      .map(head => {
        const type = typeOf(bridge, firstAt(head, 'like'))

        return {
          name: wordAt(head, 'name') ?? '',
          ...(type ? { type } : {}),
          span: spanOf(head),
        }
      })
    const extend =
      base && (pins.length > 0 || links.length > 0 || heads.length > 0)
        ? { base, heads, links, pins, span: spanOf(like) }
        : undefined
    const alias =
      base && !extend && fields.length === 0 ? base : undefined
    const variants = formsAt(value, 'case').map(arm => {
      // `case face, like face-rule` is a single-payload variant: its one field is called `value`
      const payload = typeOf(bridge, firstAt(arm, 'like'))
      const armFields = formsAt(arm, 'link').map(link => fieldOf(bridge, link))

      return {
        name: wordAt(arm, 'name') ?? '',
        fields: payload
          ? [...armFields, { name: 'value', type: payload }]
          : armFields,
      }
    })

    out.push({
      form: 'record-type',
      name,
      params,
      fields,
      variants,
      ...(indices.length > 0 ? { indices } : {}),
      ...(alias ? { alias } : {}),
      ...(extend ? { extend } : {}),
      functionFree:
        fields.every(f => f.type.kind !== 'function') &&
        variants.every(v =>
          v.fields.every(f => f.type.kind !== 'function'),
        ),
      truncation: false,
      span: spanOf(value),
    })
  }

  const outer = bridge.owner
  const outerSelf = bridge.selfType
  const outerParams = bridge.ownerParams
  bridge.owner = name
  bridge.selfType = self ?? {
    kind: 'named',
    name,
    args: params.map(p => ({ kind: 'named' as const, name: p })),
  }
  bridge.ownerParams = params

  // `wear <mask>` blocks inside the form are trait instances for it
  for (const worn of formsAt(value, 'wear')) {
    const mask = wordAt(worn, 'name')

    if (mask !== undefined) {
      out.push({
        form: 'instance',
        mask,
        target: name,
        methods: formsAt(worn, 'task')
          .map(task => wordAt(task, 'name') ?? '')
          .filter(Boolean),
        span: spanOf(worn),
      })
    }
  }

  for (const task of formsAt(value, 'task')) {
    const built = functionOf(bridge, task)

    if (built) {
      out.push(built)
    }
  }

  bridge.owner = outer
  bridge.selfType = outerSelf
  bridge.ownerParams = outerParams

  return out
}

// ---- the entry point ----

// The top-level match holds one bucket per statement KIND, so the file's own order across kinds is not in the
// map. It is recovered from the parse tree: every top-level capture carries the CST node it matched, and that
// node's position in `tree.nodes` IS the source order.
//
// Not the spans. A node a template expanded into carries no source position at all, so ordering by span puts
// every expanded definition at the top of the file, which is a different program.
function topLevelInOrder(
  match: Map<string, MillCapture[]>,
  tree: RootNode,
): MillCapture[] {
  const position = new Map<Node, number>()

  tree.nodes.forEach((node, index) => position.set(node, index))

  const all: MillCapture[] = []

  for (const captures of match.values()) {
    all.push(...captures)
  }

  return all
    .map((capture, fallback) => ({
      capture,
      at: capture.node ? (position.get(capture.node) ?? fallback) : fallback,
    }))
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.capture)
}

// A reference is a `variable` expression (a read or a call), a `record` construction, or a `named` type. A
// definition's own name is none of those, and an alias names something imported rather than defined here, so
// every match is a genuine reference.
function applyAliases(
  aliases: Map<string, string>,
  program: Program,
): void {
  if (aliases.size === 0) {
    return
  }

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)

      return
    }

    if (!node || typeof node !== 'object') {
      return
    }

    const record = node as Record<string, unknown>

    if (
      (record.form === 'variable' || record.form === 'record') &&
      typeof record.name === 'string'
    ) {
      record.name = aliases.get(record.name) ?? record.name
    } else if (
      record.kind === 'named' &&
      typeof record.name === 'string'
    ) {
      record.name = aliases.get(record.name) ?? record.name
    }

    for (const key in record) {
      const value = record[key]

      if (value && typeof value === 'object') {
        walk(value)
      }
    }
  }

  walk(program)
}

// The line the grammar stopped on, rendered as words. Without this a refusal names the file and nothing else,
// which for a 40-line `form` is not a lead, and for a source string a suite wrote inline there is no file to go
// and look at. Two levels: the node's own words, then the head word of each child.
function outlineOf(node: Node | undefined): string {
  if (!node) {
    return '(nothing)'
  }

  if (node.kind === 'name') {
    return node.parts
      .map(part => (part.kind === 'chunk' ? part.text : '{}'))
      .join('')
  }

  if (node.kind === 'text') {
    return `<${node.parts
      .map(part => (part.kind === 'chunk' ? part.text : '{}'))
      .join('')}>`
  }

  if (node.kind !== 'group') {
    return node.kind
  }

  const words: string[] = []
  const kids: string[] = []

  for (const child of node.nodes) {
    if (child.kind === 'group') {
      kids.push(outlineOf(child.nodes[0]))
    } else {
      words.push(outlineOf(child))
    }
  }

  return kids.length
    ? `${words.join(' ')} > ${kids.join(' ')}`
    : words.join(' ')
}

// The baked grammar, parsed once. `pnpm term:mill-bundle` writes the text; parsing it is cheap and happens on
// the first compile rather than at import time, so a tool that never mills never pays for it.
let baked: { mine: MineGrammar; mint: MintGrammar } | undefined

function bakedGrammar(): { mine: MineGrammar; mint: MintGrammar } {
  if (!baked) {
    const mine = parse({ file: 'code-mine.tree', text: MINE_SOURCE })
    const mint = parse({ file: 'code-mint.tree', text: MINT_SOURCE })

    baked = {
      mine: mine.ok ? readMineGrammar(mine.tree) : new Map(),
      mint: mint.ok ? readMintGrammar(mint.tree) : new Map(),
    }
  }

  return baked
}

export function millByGrammar(
  tree: RootNode,
  file: string,
  // the file's ROLE, from the project's role.tree. `site` and `call` decide what a `hook` is: a URL route or a
  // CLI command. Absent for a file no role rule matches, which is most of them. Third, so this is a drop-in
  // for the reader it replaces.
  role?: string,
  // the grammar to read with. Omitted, the baked one is used, which is what the compiler does; the parity gate
  // passes the one it loaded from disk so a grammar edit is measured before it is baked.
  grammar: { mine: MineGrammar; mint: MintGrammar } = bakedGrammar(),
): MillResult {
  const bridge: Bridge = {
    file,
    role,
    diagnostics: [],
    declared: new Set(),
    aliases: new Map(),
  }
  const mined = runMine(grammar.mine, 'code', tree)

  if (!mined.ok) {
    return {
      ok: false,
      diagnostics: [
        diagnose('unexpected-node', {
          file,
          span: mined.at ? spanOfWhole(mined.at) : ZERO_SPAN,
          message: `the code grammar does not match this file, at \`${outlineOf(mined.at)}\``,
        }),
      ],
    }
  }

  const program: Program = []

  for (const capture of topLevelInOrder(mined.match, tree)) {
    if (capture.kind !== 'match') {
      continue
    }

    for (const value of runMint(
      grammar.mint,
      capture.rule,
      capture.match,
      capture.node,
    )) {
      program.push(...topLevelOf(bridge, value))
    }
  }

  if (bridge.diagnostics.length > 0) {
    return { ok: false, diagnostics: bridge.diagnostics }
  }

  applyAliases(bridge.aliases, program)

  return { ok: true, program }
}
