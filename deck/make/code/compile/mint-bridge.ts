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
  GroupNode,
  NameNode,
  Node,
  RootNode,
} from '@term/make/code/parser/tree'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Proof,
  Statement,
  Type,
  ViewAttribute,
  ViewNode,
} from '@term/make/code/compile/node'
import {
  headWord,
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
  HALT_WORDS,
  unescapeText,
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
  // The grammar this program is being read with, so a sub-expression found inside something the grammar does
  // not descend into can still be read BY the grammar. The one place that needs it is a `{{...}}` runtime
  // interpolation, whose contents are a value the text literal holds rather than a node the mine walked.
  grammar: { mine: MineGrammar; mint: MintGrammar }
}

// Read one node as a value, through the grammar, so an interpolation's contents are lowered by the same rules
// as any other expression rather than by a second reader written here.
function expressionFromNode(
  bridge: Bridge,
  node: GroupNode,
  span: Span,
): Expression | undefined {
  const mined = runMine(bridge.grammar.mine, 'seed', {
    kind: 'root',
    nodes: [node],
  })

  if (!mined.ok) {
    return undefined
  }

  for (const captures of mined.match.values()) {
    for (const capture of captures) {
      // a literal or a bare word is captured directly and is already a value; only a nested rule needs minting
      if (capture.kind !== 'match') {
        const built = expressionOf(bridge, capture)

        if (built) {
          return built
        }

        continue
      }

      for (const value of runMint(
        bridge.grammar.mint,
        capture.rule,
        capture.match,
        capture.node,
      )) {
        const built = expressionOf(bridge, value)

        if (built) {
          return built
        }
      }
    }
  }

  return undefined
}

// A construct the reader REFUSES, with the reason. Distinct from `unhandled`, which says the bridge has not
// been taught something: this says the language has, and the answer is no.
function refuse(bridge: Bridge, value: Minted, message: string): undefined {
  bridge.diagnostics.push(
    diagnose('unexpected-node', {
      file: bridge.file,
      span: spanOf(value),
      message,
    }),
  )

  return undefined
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

// An identifier with its `{...}` TEMPLATE PARAMETERS dropped. A `{name}` in a name is filled when a `tree`
// expands, and one that survived expansion was never in a template, so the reader takes the name without it:
// `convert-to-{name}-space` is `convert-to--space`. Only a name; a `read x/{key}` member is a different thing
// and is built from the token's own interpolation part.
function plainName(name: string): string {
  return name.includes('{') ? name.replace(/\{[^}]*\}/g, '') : name
}

// A text literal, which is a STRING unless it carries `{{...}}`, and then it is a TEMPLATE: the chunks and the
// expressions between them, so `text <n= {{count}}>` interpolates at run time (a template literal on
// TypeScript, `format!` on Rust, `\(x)` on Swift, `$x` on Kotlin) instead of shipping the braces as characters.
//
// A single-brace `{x}` is a TEMPLATE PARAMETER, filled when a `tree` expands, and one that survived expansion
// was never in a template. The reader diagnoses that; the grammar path leaves the diagnosis to it and builds
// the string, because both readers run over the same input and only one of them needs to say it.
function textExpression(
  bridge: Bridge,
  value: Minted,
  span: Span,
): Expression {
  const node = value.node

  if (node?.kind !== 'text') {
    return { form: 'string', value: textOf(value) ?? '', span }
  }

  const single = node.parts.find(
    part => part.kind === 'interpolation' && part.depth < 2,
  )

  // A `{x}` is a TEMPLATE PARAMETER, filled when a `tree` expands, so one that survived expansion was never in
  // a template. It used to compile to an empty string in silence, which is why it is refused by name.
  if (single && single.kind === 'interpolation') {
    const inner = single.group ? (headWord(single.group) ?? 'x') : 'x'

    refuse(
      bridge,
      value,
      `"{${inner}}" in a text literal is a template parameter, and this text is not in a template: interpolate at run time with {{${inner}}}, or write \\{${inner}\\} for the literal braces`,
    )
  }

  const braced = node.parts.find(
    part => part.kind === 'interpolation' && part.depth >= 2,
  )

  if (!braced) {
    return { form: 'string', value: textOf(value) ?? '', span }
  }

  const parts: (string | Expression)[] = []

  for (const part of node.parts) {
    if (part.kind === 'chunk') {
      parts.push(unescapeText(part.text))
      continue
    }

    if (part.kind !== 'interpolation' || !part.group) {
      continue
    }

    // `{{e/form}}` reads a path, `{{x}}` a name, and anything else is the expression the braces hold
    const head = headWord(part.group)
    const inner =
      head !== undefined && head.includes('/') && part.group.nodes.length === 1
        ? readPath(head, span)
        : expressionFromNode(bridge, part.group, span)

    if (inner) {
      parts.push(inner)
    }
  }

  return { form: 'template', parts, span }
}

// ---- types ----

const named = (name: string): Type =>
  TYPE_NAME[name] ?? { kind: 'named', name }

// A `like` names a type and carries its parts: applied arguments ride in the name as a phrase
// (`like stack number`), an element or key/value rides as a nested `like`, and a task type carries its
// parameters as `take` lines plus its result as the nested `like`.
function typeOf(
  bridge: Bridge,
  value: Minted | undefined,
  // POSITIONAL ARGUMENTS ONLY. A `head` that carries a `like` or a `link` of its own is a NAMED type argument
  // and belongs to the extension, not to the base type: `form example / like foo / head a / link x, like text`
  // extends `foo`, it is not `foo` applied to an anonymous record.
  positionalOnly = false,
): Type | undefined {
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
      params.push(
        withHeadArgs(bridge, typeOf(bridge, firstAt(take, 'like')), take) ??
          UNKNOWN,
      )
      paramNames.push(wordAt(take, 'name'))
    }

    // EFFECTS on a callback type: `wait true` makes it async, and a bare `halt` makes it one that may raise.
    // They belong to the type, so a caller knows what the callback it is handed can do.
    const effects: string[] = []

    if (formsAt(value, 'wait').some(wait => wordAt(wait, 'seed') === 'true')) {
      effects.push('async')
    }

    if (at(value, 'halt').length > 0) {
      effects.push('throw')
    }

    return {
      kind: 'function',
      params,
      result: children[0] ?? UNIT,
      ...(paramNames.some(n => n !== undefined) ? { paramNames } : {}),
      ...(effects.length > 0 ? { effects } : {}),
    }
  }

  const base = TYPE_NAME[name]

  if (base && applied.length === 0 && children.length === 0) {
    return base
  }

  // A `head` under a `like` is either a TYPE argument or a VALUE index, and the grammar already tells them
  // apart: a type is written as a name or a nested `like` and lands at those sites, a value is an expression
  // and lands at `seed`. `like vec / head a / head / read count` is `vec a count`, a vector of `a`s whose
  // LENGTH is `count`, and the two arguments are not the same kind of thing.
  const heads = formsAt(value, 'head').filter(
    head =>
      !positionalOnly ||
      !(firstAt(head, 'like') || at(head, 'link').length > 0),
  )
  const valueHeads = heads.filter(head => firstAt(head, 'seed'))
  const args = [
    ...applied.map(phraseType),
    ...children.filter((c): c is Type => c !== undefined),
    ...heads
      .filter(head => !firstAt(head, 'seed'))
      .map(
        head =>
          typeOf(bridge, firstAt(head, 'like')) ??
          named(wordAt(head, 'name') ?? ''),
      ),
  ]
  const valueArgs = valueHeads
    .map(head => expressionOf(bridge, firstAt(head, 'seed')))
    .filter((one): one is Expression => one !== undefined)

  return {
    kind: 'named',
    name,
    ...(args.length > 0 ? { args } : {}),
    ...(valueArgs.length > 0 ? { valueArgs } : {}),
  }
}

// The `head` arguments a declaration writes BESIDE its `like` rather than inside it: `take v, like vecnat /
// head / make succ ...` fixes the vector's length at this parameter. The reader folds them into the declared
// type, so a recursive indexed family reaches the checker with its index rather than without it.
function withHeadArgs(
  bridge: Bridge,
  declared: Type | undefined,
  owner: Form,
): Type | undefined {
  if (declared?.kind !== 'named') {
    return declared
  }

  const heads = formsAt(owner, 'head')

  if (heads.length === 0) {
    return declared
  }

  const args = heads
    .filter(head => !firstAt(head, 'seed'))
    .map(
      head =>
        typeOf(bridge, firstAt(head, 'like')) ??
        named(wordAt(head, 'name') ?? ''),
    )
  const valueArgs = heads
    .filter(head => firstAt(head, 'seed'))
    .map(head => expressionOf(bridge, firstAt(head, 'seed')))
    .filter((one): one is Expression => one !== undefined)

  return {
    ...declared,
    ...(args.length > 0
      ? { args: [...(declared.args ?? []), ...args] }
      : {}),
    ...(valueArgs.length > 0
      ? { valueArgs: [...(declared.valueArgs ?? []), ...valueArgs] }
      : {}),
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

  // NO head folding here. When the parameters are written as `take` lines beside the `like` rather than inside
  // it, the reader takes each one's `like` and nothing else, so a `head` sibling of one of THOSE is not part of
  // its type. The nested spelling does fold them, and `typeOf` does that.
  const params = takes.map(
    take => typeOf(bridge, firstAt(take, 'like')) ?? UNKNOWN,
  )

  // The RESULT comes with them. A SECOND `like` beside the first is the function's return type
  // (`take f, like task / take x, like nat / like nat` is `(nat) -> nat`), and without it the type says the
  // function returns nothing, which is a different function. On a `take` the second one lands at the same
  // site; on a `link` it has its own, because there the trailing `like` is sometimes ignored instead.
  const likes = at(owner, 'like')
  const result =
    typeOf(bridge, firstAt(owner, 'result')) ??
    (likes.length > 1 ? typeOf(bridge, likes[1]) : undefined)

  // no `paramNames`: the mill records those only when the takes are nested inside the `like` group, and this
  // is the other spelling
  return { ...declared, params, ...(result ? { result } : {}) }
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
      return textExpression(bridge, value, span)
    case 'number':
      return value.decimal
        ? { form: 'float', value: value.value, span }
        : { form: 'integer', value: value.value, span }
    case 'word':
      // a bare word in value position is `true`, `false`, or a name
      if (value.value === 'true' || value.value === 'false') {
        return { form: 'boolean', value: value.value === 'true', span }
      }

      return { form: 'variable', name: plainName(value.value), span }
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
        return withLinks(bridge, readPath('', span), value)
      }

      // `read x/{key}` reads the member NAMED BY evaluating `key`. The braces are part of one name token, so
      // the segment's expression and its span come from the token's own interpolation part, which is why the
      // capture carries its CST node and not just the rendered word.
      if (path.includes('{')) {
        const dynamic = dynamicPath(value, span)

        if (dynamic) {
          return withLinks(bridge, dynamic, value)
        }
      }

      return withLinks(bridge, readPath(path, span), value)
    }

    case 'seed-text': {
      const literal = firstAt(value, 'value')

      return literal
        ? textExpression(bridge, literal, spanOf(literal))
        : // a bare `text` has no literal to take a span from, so the head's own extent stands in
          { form: 'string', value: '', span }
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

    // `fork lack` over a value: logical NOT. Its operand is a sibling of the marker, and an absent one is
    // false, which is what the reader answers.
    case 'fork-lack':
      return {
        form: 'unary',
        op: '!',
        operand: expressionOf(bridge, firstAt(value, 'seed')) ?? {
          form: 'boolean',
          value: false,
          span,
        },
        span,
      }

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
        callee: readPath(plainName(callee), span),
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

    if (field !== undefined) {
      // a `bind` with no value still names a field. The reader gives it unit rather than dropping it, so a
      // half-written construction is a field with nothing in it and not a record with one field fewer.
      fields.push({
        name: field,
        // the reader spans an absent value with the whole construction, not with the `bind` line
        value: built ?? { form: 'unit', span: spanOf(value) },
      })
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

  return withLinks(
    bridge,
    {
      form: 'record',
      name,
      fields,
      ...(positional.length > 0 ? { positional } : {}),
      functionFree,
      span: spanOf(value),
    },
    value,
  )
}

// a task written in value position is a closure: the same shape, carried as an expression
function closureOf(bridge: Bridge, value: Form): Expression | undefined {
  const params = formsAt(value, 'take').map(take => {
    // a closure's parameter folds the `head` arguments written beside its `like`, the way a task's does
    const type = withHeadArgs(
      bridge,
      typeOf(bridge, firstAt(take, 'like')),
      take,
    )

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
    // a closure is async the same two ways a task is: `note async`, or a `wait true` on the definition
    ...(marked(value, 'async') || waitsTrue(value) ? { async: true } : {}),
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
  // `wait false` on a call is FIRE AND FORGET: the call is started and not awaited, which is a different
  // thing from `wait true` and from no marker at all.
  const background = formsAt(value, 'wait').some(
    wait => wordAt(wait, 'seed') === 'false',
  )
  // `call fill / <data> / like <form>` fills a form from data, with the compiler walking the form's fields,
  // and `call melt` is the reverse. The `like` names the FORM and is not an argument, so the call carries it as
  // `into` and its callee becomes `fill-form` / `melt-form`, which is what the emitter and the checker look for.
  const into =
    name === 'fill' || name === 'melt'
      ? typeOf(bridge, firstAt(value, 'like'))
      : undefined
  const call: Expression =
    folded ??
    (into
      ? ({
          form: 'call',
          callee: readPath(`${name}-form`, span),
          args,
          into,
          span,
        } as Expression)
      : ({
          form: 'call',
          callee: readPath(name, span),
          args,
          span,
          ...(names.some(Boolean) ? { names } : {}),
          ...(propagate ? { propagate: true } : {}),
          ...(background ? { background: true } : {}),
        } as Expression))

  const awaited = formsAt(value, 'wait').some(
    wait => wordAt(wait, 'seed') === 'true',
  )

  return withLinks(bridge, awaited ? { form: 'await', expr: call, span } : call, value)
}

// `call f, x / link g / link h` PIPES: each `link` takes the running value as its first argument, so the whole
// thing reads top-down as h(g(f(x))). Anything after the function's name is a further argument, positional or
// the value of a `bind`, because the call itself is positional and the name there is documentation.
function withLinks(
  bridge: Bridge,
  value: Expression,
  owner: Form,
): Expression {
  let piped = value

  for (const link of formsAt(owner, 'link')) {
    const name = wordAt(link, 'name')

    if (name === undefined) {
      continue
    }

    const extra = at(link, 'seed')
      .map(seed => expressionOf(bridge, seed))
      .filter((one): one is Expression => one !== undefined)

    piped = {
      form: 'call',
      callee: { form: 'variable', name, span: spanOf(link) },
      args: [piped, ...extra],
      span: spanOf(link),
    }
  }

  return piped
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

    // A `halt take` that was NOT consumed as a handler above is a handler for nothing. The check lives here
    // rather than in `haltOf`, because only the statement list knows whether the `note unsafe` it belongs to
    // came before it.
    if (
      isForm(value) &&
      value.form === 'halt' &&
      wordAt(value, 'mode') === 'take'
    ) {
      refuse(
        bridge,
        value,
        'halt take is the handler of a note unsafe body and must follow one',
      )

      continue
    }

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

    // `back <value>` is the shorter spelling of `send back` and returns the same way
    case 'back':
      return {
        form: 'return',
        ...(firstAt(value, 'seed')
          ? { value: expressionOf(bridge, firstAt(value, 'seed')) }
          : {}),
        span,
      }

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
      // `fork roll`: a chain of guards. Each arm is `hook test` with its condition as the first flow, and its
      // body under a `hook hold` NESTED INSIDE that arm rather than beside it, which is what makes a roll a
      // different shape from a `fork test`.
      //
      // THE BODY USED TO BE HARDCODED EMPTY here, with a comment asserting that a roll's arms have none. They do
      // not, and the result was that every guard chain in the tree compiled to `if (a) {} else if (b) {}` with
      // every body discarded and no diagnostic: a function that silently returned nothing. The grammar dropped
      // the nested arm too (`mine flow` matches no `hook`), so both halves had to be fixed to see it at all.
      const branches = formsAt(value, 'arm').flatMap(arm => {
        const cond = expressionOf(bridge, firstAt(arm, 'flow'))

        if (!cond) {
          return []
        }

        // the body is the nested `hook hold`'s flow; an arm with no nested hold is a bare guard and has none
        const held = formsAt(arm, 'arm').find(
          nested => wordAt(nested, 'kind') === 'hold',
        )

        return [
          {
            cond,
            body: held ? scopedFlow(bridge, at(held, 'flow')) : [],
          },
        ]
      })

      return { form: 'if', branches, span }
    }

    case 'roll-def': {
      const name = wordAt(value, 'name')
      const like = wordAt(firstAt(value, 'like'), 'name') ?? wordAt(value, 'like')

      // Both halves are REQUIRED and each has its own message, because they are different mistakes: a `roll`
      // with no name does not say what kind it declares, and one with no `like` does not say what its entries
      // are. The reader names which is missing, and so does this.
      if (name === undefined) {
        return refuse(
          bridge,
          value,
          'roll needs the name of the kind it declares (`roll metric`)',
        )
      }

      if (like === undefined) {
        return refuse(
          bridge,
          value,
          `roll ${name} needs the form of its entries (\`like <form>\`)`,
        )
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

    case 'hold-claim':
      return holdOf(bridge, value)

    // RETIRED SPELLINGS. The grammar still matches them so the reader can say what to write instead: a word
    // that used to mean something deserves an answer, not "unexpected node".
    case 'bust':
      return refuse(
        bridge,
        value,
        '`bust` is retired. Write `halt <form>` with `bind` children to raise an exception, `halt <text>` to fail with a message, or `halt` to break out of a loop',
      )

    case 'send-kind':
      return wordAt(value, 'kind') === 'kink'
        ? refuse(
            bridge,
            value,
            "`send kink` is retired. Raise with `halt <form>`; pass a callee's exception on with `halt kink` under the call",
          )
        : unhandled(bridge, value, `the ${value.form} statement`)

    default:
      return unhandled(bridge, value, `the ${value.form} statement`)
  }
}

// A readable proof name (`hold <double is add>`) becomes an identifier. The reader's own slugify, so a name
// written as a phrase reaches the kernel spelled the same way from either reader.
function slugOf(phrase: string): string {
  return (
    phrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'hold'
  )
}

// One step of a proof: a head word, an optional single-word argument, and nested steps.
function proofOf(value: Minted): Proof {
  const form = value.kind === 'form' ? value : undefined

  return {
    head: (form ? wordAt(form, 'head') : textOf(value)) ?? '',
    ...(form && wordAt(form, 'arg') !== undefined
      ? { arg: wordAt(form, 'arg') as string }
      : {}),
    children: form ? at(form, 'child').map(proofOf) : [],
    span: spanOf(value),
  }
}

// `hold <claim>` states something for the kernel to verify, `hold <name>, <claim>` names it so a later `cite`
// can reuse it, and the steps under it are the proof.
function holdOf(bridge: Bridge, value: Form): Statement | undefined {
  const claim = expressionOf(bridge, firstAt(value, 'claim'))

  if (!claim) {
    return undefined
  }

  const named = firstAt(value, 'name')
  const name = named
    ? named.kind === 'text'
      ? slugOf(named.value)
      : textOf(named)
    : undefined
  const proof = at(value, 'step').map(proofOf)

  return {
    form: 'hold',
    expr: claim,
    ...(name ? { name } : {}),
    ...(proof.length > 0 ? { proof } : {}),
    span: spanOf(value),
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
  const declared = withHeadArgs(
    bridge,
    withOuterTakes(bridge, typeOf(bridge, firstAt(take, 'like')), take),
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
  // `take <name>` is callable by position or by name; `slot <name>` is POSITIONAL ONLY, and a call that names
  // one is refused. Both are parameters and they are read the same way.
  const params = [
    ...formsAt(value, 'take').map(take => paramOf(bridge, take, owner)),
    ...formsAt(value, 'slot').map(slot => ({
      ...paramOf(bridge, slot, owner),
      positional: true,
    })),
  ]

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
  const written = at(value, 'flow').filter(
    step =>
      !(
        isForm(step) &&
        step.form === 'seed-call-open' &&
        wordAt(step, 'name') === 'name'
      ),
  )

  // A LEADING RUN of childless `halt <form>` lines is a BOUND on what the task may raise, not a raise: it is a
  // contract the checker holds the body to. Only the leading run, and only a form the halt vocabulary does not
  // already claim, because `halt flow` and `halt kink` mean their own things.
  const raises: string[] = []
  let at_ = 0

  while (at_ < written.length) {
    const step = written[at_]
    const mode = isForm(step) && step.form === 'halt'
      ? wordAt(step, 'mode')
      : undefined

    if (
      mode === undefined ||
      HALT_WORDS.has(mode) ||
      !isForm(step) ||
      at(step, 'seed').length > 0 ||
      at(step, 'bind').length > 0 ||
      at(step, 'take').length > 0 ||
      at(step, 'flow').length > 0
    ) {
      break
    }

    raises.push(mode)
    at_ += 1
  }

  const steps = written.slice(at_)
  const body = flowOf(bridge, steps)
  bridge.declared = enclosing

  const generics = [
    ...(bridge.ownerParams ?? []).map(p => ({ name: p })),
    ...formsAt(value, 'head').map(head => {
      // `head t, need comparison`: the trait the type parameter is bound by. The `need` site holds the whole
      // matched rule, so the trait's name is inside it, not on the head.
      const need = wordAt(firstAt(head, 'need'), 'name')

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
    // the bound on what this task may raise, from the leading `halt <form>` lines
    ...(raises.length > 0 ? { raises } : {}),
    // `wait true` on a DEFINITION marks it async, the same as `note async`. The two are not alternatives in
    // the reader, they are two spellings of one fact, and a task that says only `wait true` is async too.
    ...(marked(value, 'async') || waitsTrue(value) ? { async: true } : {}),
    ...(marked(value, 'private') ? { private: true } : {}),
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

      // `find get as list-get` BINDS NOTHING: the words after the imported name nest under it, so the alias is
      // not an alias and the failure used to surface much later, in another file, as an undefined name. The
      // grammar captures the whole phrase so the reader can say what to write instead.
      for (const found of formsAt(value, 'find')) {
        const stray = wordAt(found, 'stray')

        if (stray === undefined) {
          continue
        }

        const words = stray.split(' ')

        refuse(
          bridge,
          found,
          `"find ${stray}" binds nothing: an import alias is written "find ${words[0] ?? ''}, name ${words[words.length - 1] ?? 'y'}"`,
        )
      }

      return []

    // a package manifest read by the code role, which is not code: the deck dialect owns it
    case 'deck-def':
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

    // RETIRED. `dock` was also a routing form, an alias for `hook`, so one word meant both the native FFI
    // binding and a URL route. Four uses existed and all were ported; refusing it is what stops it coming
    // back, because a second spelling nobody removes is a second spelling somebody writes.
    case 'dock-def':
      refuse(
        bridge,
        value,
        '`dock` is the native FFI binding (`dock load`, `dock type`). A URL route is `hook </path>`',
      )

      return []

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

    case 'rule-def':
      return ruleOf(bridge, value)

    case 'view-def':
      return viewOf(bridge, value)

    // `tell @deck/form`: what a customer sees when this exception reaches them. Absent means private, so the
    // statement is the app's decision and the compiler holds it to one.
    case 'tell': {
      const named = wordAt(value, 'name')

      if (named === undefined) {
        refuse(
          bridge,
          value,
          'tell needs the full name of an exception (@deck/form)',
        )

        return []
      }

      const said = (site: string): string | undefined =>
        wordAt(firstAt(value, site), 'value')

      const note = said('note')
      const hint = said('hint')
      const alias = said('alias')

      return [
        {
          form: 'tell',
          name: named,
          ...(note !== undefined ? { note } : {}),
          ...(hint !== undefined ? { hint } : {}),
          links: formsAt(value, 'link')
            .map(link => wordAt(link, 'name') ?? '')
            .filter(one => one.length > 0),
          ...(alias !== undefined ? { alias } : {}),
          span: spanOf(value),
        },
      ]
    }

    // a proof `hold` written at the top level rather than inside a task body
    case 'hold-claim':
      return asStatements(holdOf(bridge, value))

    default:
      return asStatements(statementOf(bridge, value))
  }
}

// A rule's goal: one nested expression, or a RELATION applied to terms written on one line
// (`show hold, twin, bond a b, bond c d`), which is the same shape a `have` hypothesis takes.
function claimOf(bridge: Bridge, shown: Form): Expression | undefined {
  const seeds = at(shown, 'seed')

  if (seeds.length <= 1) {
    return expressionOf(bridge, seeds[0])
  }

  const span = spanOf(shown)
  const callee = textOf(seeds[0]) ?? headWordOf(seeds[0]) ?? ''
  const args = seeds
    .slice(1)
    .map(seed => expressionOf(bridge, seed))
    .filter((one): one is Expression => one !== undefined)

  return (
    foldBuiltin(callee, args, span) ?? {
      form: 'call',
      callee: readPath(callee, span),
      args,
      span,
    }
  )
}

// the head word a minted value was built from, for a relation written as a bare name
// Metadata written as `note <word>` or as `mark <word>`. The documented spelling is `note`, and `mark` is
// accepted alongside it because it is live in about thirty files: `mark private` on a record field, `mark
// async` in the stdlib's async tasks, and several fixtures. Refusing it was tried and reverted.
function marked(value: Form, word: string): boolean {
  return (
    hasWord(value, 'note', word) ||
    formsAt(value, 'mark').some(mark => wordAt(mark, 'kind') === word)
  )
}

// `wait true` written on the definition itself. `wait false` is fire-and-forget and is not this: the marker's
// value is a `seed`, and only the boolean true means await.
function waitsTrue(value: Form): boolean {
  return formsAt(value, 'wait').some(
    wait => wordAt(wait, 'seed') === 'true',
  )
}

function headWordOf(value: Minted | undefined): string | undefined {
  return value?.kind === 'form'
    ? (wordAt(value, 'name') ?? wordAt(value, 'path'))
    : undefined
}

// `show miss` proves the claim FALSE. An ORDER comparison flips to its complement, because `not (a > b)` and
// `a <= b` are the same statement and the prover works with the second; anything else is logically negated.
function negated(claim: Expression, span: Span): Expression {
  if (claim.form === 'binary') {
    const flip: Record<string, string> = {
      '>': '<=',
      '<': '>=',
      '>=': '<',
      '<=': '>',
    }
    const flipped = flip[claim.op]

    if (flipped) {
      return { ...claim, op: flipped as typeof claim.op }
    }
  }

  return { form: 'unary', op: '!', operand: claim, span }
}

// ---- the component (`view` in the code role) ----

// One markup node. The eight the component grammar knows, and nothing else: a head it does not know is a
// mistake the reader refuses rather than drops, and the grammar refuses it in the same place.
function viewNodeOf(bridge: Bridge, value: Minted): ViewNode | undefined {
  const span = spanOf(value)

  // a bare text literal sitting in a body, rather than `text <...>`
  if (value.kind === 'text') {
    return { form: 'text', value: value.value, span }
  }

  if (value.kind !== 'form') {
    return undefined
  }

  const element = formsAt(value, 'element')[0]

  if (element) {
    return viewElementOf(bridge, element, span)
  }

  const text = firstAt(value, 'text')

  if (text) {
    return { form: 'text', value: wordAt(text, 'value') ?? '', span }
  }

  const read = firstAt(value, 'read')

  if (read) {
    const inner = expressionOf(bridge, firstAt(read, 'seed'))

    return inner ? { form: 'read', value: inner, span } : undefined
  }

  const slot = firstAt(value, 'slot')

  if (slot) {
    const name = wordAt(slot, 'name')

    return name ? { form: 'slot', name, span } : { form: 'slot', span }
  }

  const fork = firstAt(value, 'fork')

  if (fork) {
    const test = firstAt(fork, 'test')
    const cond = test
      ? expressionOf(bridge, firstAt(test, 'seed'))
      : undefined
    const miss = formsAt(fork, 'miss')[0]

    return {
      form: 'fork',
      branches: [
        {
          // no `hook test` at all is a branch that never runs, which is what the reader answers too
          cond: cond ?? { form: 'boolean', value: false, span },
          body: viewBodyOf(bridge, formsAt(fork, 'hold')[0]),
        },
      ],
      ...(miss ? { otherwise: viewBodyOf(bridge, miss) } : {}),
      span,
    }
  }

  const walk = firstAt(value, 'walk')

  if (walk) {
    const next = formsAt(walk, 'next')[0]
    const named = next ? firstAt(next, 'item') : undefined
    // `take site, name <item>` gives the loop variable its name; without one the reader calls it `item`
    const item = named
      ? (wordAt(firstAt(named, 'name'), 'name') ?? 'item')
      : 'item'

    return {
      form: 'walk',
      iterable: expressionOf(bridge, firstAt(walk, 'seed')) ?? {
        form: 'unit',
        span,
      },
      item,
      body: viewBodyOf(bridge, next),
      span,
    }
  }

  const save = firstAt(value, 'save')

  if (save) {
    const name = wordAt(save, 'name')

    if (name === undefined) {
      return undefined
    }

    return {
      form: 'save',
      name,
      value: expressionOf(bridge, firstAt(save, 'seed')) ?? {
        form: 'unit',
        span,
      },
      span,
    }
  }

  const call = firstAt(value, 'call')

  if (call) {
    const built = expressionOf(bridge, call)

    return built ? { form: 'call', value: built, span } : undefined
  }

  return undefined
}

// the markup under a node that holds some: a fork arm, a walk's `hook next`, or an element
function viewBodyOf(bridge: Bridge, holder: Form | undefined): ViewNode[] {
  if (!holder) {
    return []
  }

  const out: ViewNode[] = []

  for (const node of at(holder, 'node')) {
    const built = viewNodeOf(bridge, node)

    if (built) {
      out.push(built)
    }
  }

  return out
}

// A handler or attribute value. ONE node is the value; MORE than one is a statement BODY and becomes a closure,
// which is what lets a two-line click handler run both of its lines.
function viewHandlerOf(
  bridge: Bridge,
  holder: Form,
): { value: Expression | undefined; multi: boolean } {
  const seeds = at(holder, 'seed')

  if (seeds.length > 1) {
    return {
      multi: true,
      value: {
        form: 'closure',
        params: [],
        body: flowOf(bridge, seeds),
        span: spanOf(holder),
      },
    }
  }

  return { multi: false, value: expressionOf(bridge, seeds[0]) }
}

function viewElementOf(
  bridge: Bridge,
  value: Form,
  span: Span,
): ViewNode | undefined {
  const name = wordAt(value, 'name')

  if (name === undefined) {
    return undefined
  }

  const attributes: ViewAttribute[] = []

  for (const attribute of formsAt(value, 'attribute')) {
    const label = wordAt(attribute, 'name')

    if (label === undefined) {
      continue
    }

    const { value: built, multi } = viewHandlerOf(bridge, attribute)
    // an attribute whose value is a CALL, or a whole statement body, is an event handler
    const first = at(attribute, 'seed')[0]
    const event =
      multi || (first?.kind === 'form' && first.form === 'call')

    attributes.push({
      name: label,
      value: built ?? { form: 'unit', span },
      event,
      span: spanOf(attribute),
    })
  }

  for (const handler of formsAt(value, 'event')) {
    const label = wordAt(handler, 'name')
    const { value: built } = viewHandlerOf(bridge, handler)

    if (label !== undefined && built) {
      attributes.push({
        name: label,
        value: built,
        event: true,
        span: spanOf(handler),
      })
    }
  }

  const props: { name: string; value: Expression }[] = []

  for (const prop of formsAt(value, 'prop')) {
    const label = wordAt(prop, 'name')

    if (label === undefined) {
      continue
    }

    props.push({
      name: label,
      value: expressionOf(bridge, firstAt(prop, 'seed')) ?? {
        form: 'unit',
        span,
      },
    })
  }

  const children: ViewNode[] = []

  for (const child of at(value, 'child')) {
    const built = viewNodeOf(bridge, child)

    if (built) {
      children.push(built)
    }
  }

  const ref = wordAt(firstAt(value, 'ref'), 'name')

  return {
    form: 'element',
    name,
    attributes,
    props,
    children,
    ...(ref !== undefined ? { ref } : {}),
    // `node <tag>` forces an html element even where `<tag>` also names a component
    forced: wordAt(value, 'kind') === 'node',
    span,
  }
}

// `view <name>` at the top level DEFINES a component: its `take` lines are its parameters, and everything that
// is not part of the signature is its markup.
function viewOf(bridge: Bridge, value: Form): Statement[] {
  const name = wordAt(value, 'name')

  if (name === undefined) {
    return []
  }

  const params = formsAt(value, 'take').map(take => {
    const type = typeOf(bridge, firstAt(take, 'like'))

    return {
      name: wordAt(take, 'name') ?? '',
      ...(type ? { type } : {}),
    }
  })

  return [
    {
      form: 'view',
      name,
      params,
      body: viewBodyOf(bridge, value),
      span: spanOf(value),
    },
  ]
}

// A `rule` is a named THEOREM or AXIOM, and it desugars to a FUNCTION: its universal `mark` binders become the
// parameters, so the goal is checked as a law over them by the same prover stack a `hold` uses. A theorem's body
// is the goal held under its hypotheses; an axiom's is the hypotheses and the claim bound as values, postulated
// rather than proved. See note/library/seed/proof-checking/08-structured-rule-dsl.md.
function ruleOf(bridge: Bridge, value: Form): Statement[] {
  const span = spanOf(value)
  const named = firstAt(value, 'name')
  const name =
    (named?.kind === 'text' ? slugOf(named.value) : textOf(named)) ?? 'rule'

  // `mark x, like natural-number` carries the n >= 0 bound the prover needs, and the refinement is read from
  // the type's NAME: `typeOf` maps it to the plain number type and the name is gone by then.
  const params = formsAt(value, 'mark').map(mark => {
    const like = firstAt(mark, 'like')
    // `mark s, like stack / head nat` quantifies over a stack OF NATS, and the argument is a sibling of the
    // `like`, the same way a task parameter's is
    const type = withHeadArgs(bridge, typeOf(bridge, like), mark)
    const written = wordAt(like, 'name')

    return {
      name: wordAt(mark, 'name') ?? '',
      ...(type ? { type } : {}),
      ...(written === 'natural-number' ? { refine: 'natural' as const } : {}),
    }
  })

  const hypotheses = formsAt(value, 'have').map((have, at) => ({
    name: wordAt(have, 'name') ?? `claim_${at}`,
    expr: expressionOf(bridge, firstAt(have, 'seed')),
  }))

  const witnesses = formsAt(value, 'find').map(find => ({
    name: wordAt(find, 'name') ?? '',
    value: expressionOf(bridge, firstAt(find, 'seed')),
  }))

  const shown = formsAt(value, 'show')[0]
  const claim = shown ? claimOf(bridge, shown) : undefined
  // `show miss <claim>` proves the claim FALSE
  const goal =
    claim && wordAt(shown, 'mode') === 'miss'
      ? negated(claim, span)
      : claim
  const axiom = formsAt(value, 'base').length > 0
  const proof = at(value, 'step').map(proofOf)

  const body: Statement[] = witnesses
    .filter(w => w.value)
    .map(w => ({
      form: 'let' as const,
      mutable: false,
      name: w.name,
      init: w.value as Expression,
      span,
    }))

  if (goal) {
    if (axiom) {
      for (const hypothesis of hypotheses) {
        if (hypothesis.expr) {
          body.push({
            form: 'let',
            mutable: false,
            name: hypothesis.name,
            init: hypothesis.expr,
            span,
          })
        }
      }

      body.push({
        form: 'let',
        mutable: false,
        name: 'claim',
        init: goal,
        span,
      })
    } else {
      // each hypothesis becomes a guard around the goal, innermost last, which is how an implication is proved:
      // the prover assumes every antecedent while discharging the conclusion
      let held: Statement[] = [
        {
          form: 'hold',
          name,
          expr: goal,
          ...(proof.length > 0 ? { proof } : {}),
          span,
        },
      ]

      for (let at = hypotheses.length - 1; at >= 0; at--) {
        const cond = hypotheses[at]?.expr

        if (cond) {
          held = [{ form: 'if', branches: [{ cond, body: held }], span }]
        }
      }

      body.push(...held)
    }
  }

  body.push({
    form: 'return',
    value: params[0]
      ? readPath(params[0].name, span)
      : { form: 'unit', span },
    span,
  })

  return [{ form: 'function', name, params, body, generics: [], span }]
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
  // `hook` spells two things. A ROUTE (role `site`, or a path, or a component) carries a component and no help
  // text; a CLI COMMAND carries help text and the task it runs. Telling them apart from content alone was the
  // guess role.tree exists to end, so the role decides first.
  //
  // THIS HAS TO BE DECIDED BEFORE THE TAKES ARE READ, because a route reads four of its take names as sections
  // and a command must not.
  const path = wordAt(value, 'name') ?? ''
  const isRoute =
    bridge.role === 'site' ||
    (bridge.role !== 'call' &&
      (path.startsWith('/') || formsAt(value, 'view').length > 0))

  // `take path` / `take query` / `take body` / `take head` are SECTIONS ON A ROUTE, not parameters: they group
  // the route's real takes by where they come from, and the takes are the ones nested inside them.
  //
  // ON A CLI COMMAND THEY ARE ORDINARY PARAMETERS. `term roll --path` and `term view <path>` are both real, and
  // both silently vanished while this applied to every hook: the section rule lifted the nested takes of a
  // `take path` that had none, so the parameter was replaced by nothing at all, with no diagnostic. Found writing
  // deck/call/code/line/base.tree, which is the first `.tree` file to describe those two commands.
  const SECTION = new Set(['path', 'query', 'body', 'head'])
  const takeList = formsAt(value, 'take').flatMap(take =>
    isRoute && SECTION.has(wordAt(take, 'name') ?? '')
      ? formsAt(take, 'take')
      : [take],
  )
  const takes = takeList.map(take => {
    const type = typeOf(bridge, firstAt(take, 'like'))
    const note = leadingNote(take) ?? wordAt(firstAt(take, 'note'), 'text')
    const short = wordAt(take, 'code')
    // `take code / wait rise` reads a secret without echoing it back
    const masked = formsAt(take, 'wait').some(
      wait => wordAt(wait, 'seed') === 'rise',
    )
    // `take format / pick <human> / pick <json>`: the allowed-value set. One `pick` per value, so the site holds
    // them in order. `textOf` takes both spellings, a text literal and a bare word.
    const choices = at(take, 'pick')
      .map(textOf)
      .filter((value): value is string => value !== undefined)
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
      ...(masked ? { masked: true } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      ...(at(take, 'many').length > 0 ? { variadic: true } : {}),
      ...(choices.length > 0 ? { choices } : {}),
      span: spanOf(take),
    }
  })

  // AN EXPLICIT `note` WINS over the `#` comment above the hook. It reads the other way round at first glance,
  // since the comment is the ordinary way to write help text, but a comment is INFERRED and a `note` is stated,
  // and the stated one has to be able to correct the inference.
  //
  // The case that needs it: a file-header comment attaches to the first definition under it, because comments
  // attach to the next node and a blank line does not break the run. `deck/zone/code/line/base.tree` gets away
  // with it only because its `load` statements sit between its header and its first `hook`. A file whose first
  // statement IS a hook has no way to carry a header without it becoming that command's help, and
  // `deck/call/code/line/base.tree` is exactly that file. Nothing in the tree sets both, so this cannot change
  // any existing help text.
  const help = isRoute
    ? undefined
    : (wordAt(firstAt(value, 'note'), 'text') ?? leadingNote(value))

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
    // The KEY is what tells a route from a command downstream, so a route writes it whether or not it has a
    // component to put in it: `hook /users / task get` is a route with no view, not a CLI command.
    ...(isRoute ? { component } : {}),
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
        // `case rust / load <num_bigint::BigInt>`: an import the native expression needs. The path is a text
        // literal captured at `path`, so the whole match carries it rather than being one itself.
        ...formsAt(target, 'load')
          .map(load => ({ module: wordAt(load, 'path') ?? '' }))
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
  const declared = withHeadArgs(
    bridge,
    withOuterTakes(bridge, typeOf(bridge, like), link),
    link,
  )
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
    // A DEFAULT does not make a field optional. `need false` does, and only that: `link actual, like number,
    // fall 0` is a required field that has a value when none is given, which is a different thing from one the
    // constructor may leave out.
    ...(need === 'false' ? { optional: true } : {}),
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
    // A form's fields, in the order they were written. `link` and `free` name a field; `slot` makes it
    // POSITIONAL, so `make point(code 1, code 2)` fills them in order and a form without slots refuses bare
    // values. The three heads share one field reader in `compile/mill.ts`, and share one here.
    const fields = [
      ...formsAt(value, 'link').map(link => fieldOf(bridge, link)),
      ...formsAt(value, 'slot').map(slot => ({
        ...fieldOf(bridge, slot),
        positional: true,
      })),
    ]
    // `like <base>` on a form: with children it EXTENDS the base (`bind` pins one of its fields, `link` adds a
    // prop, `head` names a type argument), and with none it is a transparent ALIAS of it
    const like = firstAt(value, 'like')
    const base = typeOf(bridge, like, true)
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
        // `head a / link x, like text`: an anonymous record as the argument, its fields written inline
        const links = formsAt(head, 'link').map(link => {
          const field = fieldOf(bridge, link)

          return { name: field.name, type: field.type }
        })

        return {
          name: wordAt(head, 'name') ?? '',
          ...(type ? { type } : {}),
          ...(links.length > 0 ? { links } : {}),
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
      // An INDEXED family's variant says what the index is AT this constructor: `case vnil / head / make zero`
      // fixes the length to zero, and `case vcons / head / make succ ...` to one more than its tail's. Only a
      // form that declares indices has them, which is the reader's own guard.
      const indexValues =
        indices.length > 0
          ? at(arm, 'head')
              .map(head => expressionOf(bridge, firstAt(head, 'seed')))
              .filter((one): one is Expression => one !== undefined)
          : []

      return {
        name: wordAt(arm, 'name') ?? '',
        fields: payload
          ? [...armFields, { name: 'value', type: payload }]
          : armFields,
        ...(indexValues.length > 0 ? { indexValues } : {}),
      }
    })

    out.push({
      form: 'record-type',
      name,
      params,
      fields,
      variants,
      ...(indices.length > 0 ? { indices } : {}),
      // `mark prop`: a propositional truncation, where any two inhabitants are equal. Always written, true or
      // false, because the reader always writes it and a missing field is a different program from a false one.
      truncation: formsAt(value, 'mark').some(
        mark => wordAt(mark, 'kind') === 'prop',
      ),
      ...(alias ? { alias } : {}),
      ...(extend ? { extend } : {}),
      functionFree:
        fields.every(f => f.type.kind !== 'function') &&
        variants.every(v =>
          v.fields.every(f => f.type.kind !== 'function'),
        ),
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

      // AND ITS IMPLEMENTATIONS. The instance says which methods the form wears; the methods themselves are
      // lifted out as functions over the form, dispatched exactly like its own. Without them the instance
      // named methods that nothing defined.
      for (const task of formsAt(worn, 'task')) {
        const built = functionOf(bridge, task)

        if (built) {
          out.push(built)
        }
      }
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
    grammar,
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
      // EACH TOP-LEVEL STATEMENT GETS A FRESH SCOPE. The reader lowers one at a time with an empty one, so a
      // second `save a` at the top level is a fresh binding rather than an assignment to the first.
      bridge.declared = new Set()
      program.push(...topLevelOf(bridge, value))
    }
  }

  if (bridge.diagnostics.length > 0) {
    return { ok: false, diagnostics: bridge.diagnostics }
  }

  applyAliases(bridge.aliases, program)

  return { ok: true, program }
}
