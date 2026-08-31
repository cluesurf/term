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

import type { Node, RootNode } from '@term/make/code/parser/tree'
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
  ZERO_SPAN,
} from '@term/make/code/compile/mill-run'
import type {
  Minted,
  MillCapture,
} from '@term/make/code/compile/mill-run'
import type { LoadedGrammar } from '@term/make/code/compile/mill-load'
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
  ]

  return {
    kind: 'named',
    name,
    ...(args.length > 0 ? { args } : {}),
  }
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
    case 'seed-read':
    case 'read': {
      const path = wordAt(value, 'path') ?? wordAt(value, 'name')

      if (path === undefined) {
        return unhandled(bridge, value, 'a read with no path')
      }

      return readPath(path, span)
    }

    case 'seed-text': {
      const literal = firstAt(value, 'value')

      return {
        form: 'string',
        value: textOf(literal) ?? '',
        span: spanOf(literal),
      }
    }

    case 'seed-code': {
      const literal = firstAt(value, 'value')

      if (literal?.kind === 'number') {
        return literal.decimal
          ? { form: 'float', value: literal.value, span: spanOf(literal) }
          : { form: 'integer', value: literal.value, span: spanOf(literal) }
      }

      return { form: 'integer', value: 0, span }
    }

    case 'seed-term':
      return {
        form: 'variable',
        name: wordAt(value, 'name') ?? '',
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
      const inner = firstAt(value, 'seed')

      return inner ? expressionOf(bridge, inner) : undefined
    }

    case 'seed-call-open': {
      // a bare call written as its own head (`name <document>`): the head is the callee, the rest its arguments
      const callee = wordAt(value, 'name')

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
    return unhandled(bridge, value, 'a make with no form name')
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

  // `make list` and `make hash` are the native collections, not records of those names
  if (name === 'list' && fields.length === 0) {
    return { form: 'array', items: positional, span: spanOf(value) }
  }

  if (name === 'hash' && fields.length === 0) {
    return { form: 'map', entries: [], span: spanOf(value) }
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
    built.otherwise && built.otherwise.length === 1 && last?.form === 'expression'
      ? last.expr
      : undefined

  return {
    form: 'conditional',
    branches,
    ...(otherwise ? { otherwise } : {}),
    span,
  }
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
    node = { form: 'member', target: node, name: part, span }
  }

  return node
}

function callOf(bridge: Bridge, value: Form): Expression | undefined {
  const name = wordAt(value, 'name')

  if (name === undefined) {
    return unhandled(bridge, value, 'a call with no name')
  }

  const span = spanOf(value)
  const args: Expression[] = []
  const names: (string | undefined)[] = []

  for (const bind of formsAt(value, 'bind')) {
    const built = expressionOf(bridge, firstAt(bind, 'seed'))

    if (built) {
      args.push(built)
      names.push(wordAt(bind, 'name'))
    }
  }

  for (const seed of at(value, 'seed')) {
    const built = expressionOf(bridge, seed)

    if (built) {
      args.push(built)
      names.push(undefined)
    }
  }

  // the arithmetic and comparison builtins lower to an operator, not a call: they have no definition to bind to
  const folded = foldBuiltin(name, args, span)

  const call: Expression =
    folded ??
    ({
      form: 'call',
      callee: readPath(name, span),
      args,
      span,
      ...(names.some(Boolean) ? { names } : {}),
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

  for (const value of values) {
    const built = statementOf(bridge, value)

    if (built) {
      body.push(built)
    }
  }

  return body
}

function statementOf(
  bridge: Bridge,
  value: Minted,
): Statement | undefined {
  if (!isForm(value)) {
    return unhandled(bridge, value, 'a bare value as a statement')
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
      // difference is whether the name is already in scope.
      if (bridge.declared.has(name)) {
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

      return { form: 'let', name, init, mutable: true, span }
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
function loopOf(bridge: Bridge, value: Form): Statement | undefined {
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
      body: flowOf(bridge, at(next, 'flow')),
      span,
    }
  }

  if (mode === 'test') {
    const test = hooks.find(h => wordAt(h, 'name') === 'test')
    const step = hooks.find(h => {
      const name = wordAt(h, 'name')

      return name === 'step' || name === 'hold'
    })
    // `walk test` with no condition loops until something breaks out of it
    const cond = expressionOf(bridge, firstAt(test, 'flow')) ?? {
      form: 'boolean' as const,
      value: true,
      span,
    }

    return {
      form: 'while',
      cond,
      body: step ? flowOf(bridge, at(step, 'flow')) : [],
      span,
    }
  }

  return unhandled(bridge, value, `a walk in ${mode ?? '(no)'} mode`)
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
    const body = flowOf(bridge, at(arm, 'flow'))

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

  // a `host` whose children are more `host` lines is an anonymous record: a constant written as a little tree
  const nested = formsAt(value, 'host')
  const init =
    nested.length > 0
      ? anonymousRecord(bridge, nested, span)
      : (expressionOf(bridge, seed) ?? { form: 'unit' as const, span })

  return {
    form: 'let',
    name,
    init,
    mutable: false,
    ...(type ? { type } : {}),
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

  const inline = expressionOf(bridge, firstAt(value, 'condition'))

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
        otherwise = flowOf(bridge, flow)
        continue
      }

      branches.push({ cond: pending, body: flowOf(bridge, flow) })
      pending = undefined
      continue
    }

    if (kind === 'miss' || kind === 'else' || kind === 'fall') {
      otherwise = flowOf(bridge, flow)
      continue
    }

    return unhandled(bridge, arm, `a fork arm named ${kind ?? '(nothing)'}`)
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
  const declared = typeOf(bridge, firstAt(take, 'like'))
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
    return unhandled(bridge, value, 'a task with no name')
  }

  const owner = bridge.owner
  const name = owner ? `${owner}_${bare}` : bare
  const params = formsAt(value, 'take').map(take =>
    paramOf(bridge, take, owner),
  )

  const result = typeOf(bridge, firstAt(value, 'like'))
  // a function body is its own scope: a `save` inside it declares, whatever the enclosing body has bound
  const enclosing = bridge.declared
  bridge.declared = new Set(params.map(p => p.name))
  const body = flowOf(bridge, at(value, 'flow'))
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
    const built = statementOf(bridge, value)

    return built ? [built] : []
  }

  switch (value.form) {
    case 'load':
    case 'bear':
      // imports are resolved by the module loader and carry no statement
      return []

    case 'form':
      return formOf(bridge, value)

    case 'dock-bind':
      return nativeOf(bridge, value)

    case 'mask':
    case 'suit': {
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

    default: {
      const built = statementOf(bridge, value)

      return built ? [built] : []
    }
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
  const targets = formsAt(value, 'case').map(target => ({
    env: wordAt(target, 'platform') ?? '',
    expression:
      wordAt(firstAt(target, 'seed'), 'value') ??
      wordAt(target, 'text') ??
      '',
    imports: at(target, 'load')
      .map(load => ({
        module: textOf(load) ?? wordAt(load, 'value') ?? '',
      }))
      .filter(i => i.module !== ''),
  }))

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
  optional?: boolean
  fallback?: Expression
} {
  const like = firstAt(link, 'like')
  const listOf = firstAt(link, 'list')
  const declared = typeOf(bridge, like)
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

  return {
    name: wordAt(link, 'name') ?? '',
    type,
    identity: false,
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
  const params = formsAt(value, 'head')
    .map(head => wordAt(head, 'name') ?? '')
    .filter(Boolean)

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
    const variants = formsAt(value, 'case').map(arm => ({
      name: wordAt(arm, 'name') ?? '',
      fields: formsAt(arm, 'link').map(link => fieldOf(bridge, link)),
    }))

    out.push({
      form: 'record-type',
      name,
      params,
      fields,
      variants,
      functionFree: fields.every(f => f.type.kind !== 'function'),
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

export function millByGrammar(
  tree: RootNode,
  file: string,
  grammar: LoadedGrammar,
): MillResult {
  const bridge: Bridge = { file, diagnostics: [], declared: new Set() }
  const mined = runMine(grammar.mine, 'code', tree)

  if (!mined.ok) {
    return {
      ok: false,
      diagnostics: [
        diagnose('unexpected-node', {
          file,
          span: mined.at ? spanOfWhole(mined.at) : ZERO_SPAN,
          message: 'the code grammar does not match this file',
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

  return { ok: true, program }
}
