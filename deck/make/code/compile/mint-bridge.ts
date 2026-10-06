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

import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, NameNode, RootNode } from '@term/make/code/parser/narrow'
import { partsOf, isGroup } from '@term/make/code/parser/narrow'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  DockLiteral,
  Expression,
  Program,
  Proof,
  Statement,
  TemplatePart,
  Twin,
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
  readLeanRules,
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
  isTypeName,
  typeOfWord,
  isBinaryBuiltin,
  binaryBuiltinOp,
  isUnaryBuiltin,
  isHaltWord,
  unescapeText,
} from '@term/make/code/compile/surface'
import {
  freeUnknownType,
  unknownType,
  unitType,
  chunkPart,
  valuePart,
} from '@term/make/code/compile/node'

// an integer literal of any size the parser read: past 2^53 it carries its exact digits (compile/node.ts, `digits`)
function integerLiteral(value: number | bigint, span: Span): Expression {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value))
      ? { form: 'integer', value: Number(value), span }
      : { form: 'integer', value: Number(value), digits: value.toString(), span }
  }

  return { form: 'integer', value, span }
}
import { baseRefusal } from '@term/make/code/deck/resolve'

export type MillResult =
  // `twins` sit beside the program and never in it (node.ts, `Twin`), so a reader that ignores them is correct
  | { ok: true; program: Program; twins?: Twin[] }
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
  // `mark lean` on the file's role rule: a bare head is a call, a property head is a named argument. The pass
  // that acts on it runs before any minting, so by the time this bridge reads anything the match is already the
  // longhand one. Carried here only so a diagnostic can say which surface a file was read with.
  lean?: boolean
  diagnostics: Diagnostic[]
  // the form a nested `task` belongs to: its methods are mangled `<form>_<name>` and a bare `take self` takes
  // the form's own type
  owner?: string
  // what `self` is typed as inside that form: the form itself, or the primitive / collection it stands for
  selfType?: Type
  // the names already bound in the body being built, so a second `save` of one is an assignment
  declared: Set<string>
  // every OTHER local name in scope that `declared` does not carry, because adding one there would turn a later
  // `save` of it into an assignment: a closure's parameters, a walk's item and index, a `fork case` arm's
  // `link` names, a handler's caught exception, a `host` constant in a body. Read with `declared` by `inScope`,
  // and only to decide what a bare value word (`term`, `text`, `code`) means.
  bound: Set<string>
  // a `save` that declared a name its own value reads (`save callee, rewrite(callee)` under `case call`): the new
  // local is renamed `<name>__<n>` so the value reads the OUTER `callee`, and `flowOf` renames the uses after it
  shadowed?: { from: string; to: string }
  // the count behind those fresh names
  shadows?: number
  // inside a task's or a closure's body, as opposed to the top level of the file
  inBody?: boolean
  // the file defines a task named `host` or imports one, so a `host` statement in a body may mean the call
  hostTask?: boolean
  // every name the file defines or imports (`namesInFile`)
  named: Set<string>
  // the owning form's type parameters: every method of the form carries them as leading generics
  ownerParams?: string[]
  // `find X, name Y`: Y is a local synonym for X in this file, rewritten to X across the built program
  aliases: Map<string, string>
  // The grammar this program is being read with, so a sub-expression found inside something the grammar does
  // not descend into can still be read BY the grammar. The one place that needs it is a `{{...}}` runtime
  // interpolation, whose contents are a value the text literal holds rather than a node the mine walked.
  grammar: Grammar
  // the file's `twin` declarations, returned beside the program rather than in it (node.ts, `Twin`)
  twins: Twin[]
  // how many `walk size` loops this file has minted so far, which names each one's temporaries (`walk-head-<n>`,
  // `walk-step-<n>`, a renamed counter `<item>-walk-<n>`). An object, so the copies a nested body makes share one
  // count. Named by ORDER, never by position: a position is exactly what formatting moves, and a name that changes
  // under formatting made the formatter's meaning check (format/meaning.ts) strip it with a regex
  walks: { count: number }
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

// Read nodes as STATEMENTS, through the grammar's own `flow` rule, one line at a time. For a body the grammar
// matched as something else and so never descended into as statements: a bare `hold` under a `walk test`, whose
// lines the walk rule captured as a value or a proof claim (`loopOf`).
function flowFromNodes(bridge: Bridge, nodes: Node[]): Minted[] {
  const out: Minted[] = []

  for (const node of nodes) {
    const mined =
      node.kind === 'group'
        ? runMine(bridge.grammar.mine, 'flow', { kind: 'root', nodes: [node] })
        : { ok: false as const }

    if (!mined.ok) {
      bridge.diagnostics.push(
        diagnose('unexpected-node', {
          file: bridge.file,
          span: spanOfWhole(node),
          message: `the code grammar does not read this line as a statement, at \`${outlineOf(node)}\``,
        }),
      )
      continue
    }

    for (const captures of mined.match.values()) {
      for (const capture of captures) {
        if (capture.kind !== 'match') {
          out.push(capture as Minted)
          continue
        }

        out.push(
          ...runMint(bridge.grammar.mint, capture.rule, capture.match, capture.node),
        )
      }
    }
  }

  return out
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

// Every head `mine flow` lists as a statement (mill/code/code/tool/flow/mine.tree), in that file's own order.
// None of them can be a bare-head call: the grammar matches the statement rule first, so a word from this set
// arriving as a lean CALLEE means its own rule refused the line and the generic "an unknown head is a call"
// fallback took it.
const FLOW_HEADS = new Set([
  'hold',
  'call',
  'save',
  'send',
  'back',
  'fork',
  'sift',
  'halt',
  'bust',
  'walk',
  'turn',
  'fuse',
  'rest',
  'note',
  'read',
  'free',
  'make',
  'move',
  'host',
])

// A statement head read as a lean call: the head ends up with two children where its rule allows one, as in
// `back add(1, a), 2`, and the old message named the head as an undefined task. Name the real cause and the two
// ways out of it instead. Before 2026-10-02 a comma after a literal or a closed call popped out of the call it
// sat in, so `back substring one, 0, 1` and `fork test, is-equal size(x), 1` fell in here; they no longer do.
function commaTrap(
  bridge: Bridge,
  value: Minted,
  head: string,
  span: Span,
): undefined {
  bridge.diagnostics.push(
    diagnose('unexpected-node', {
      file: bridge.file,
      span,
      message: `\`${head}\` is a statement, and its grammar could not read this line, so it was read as a call to a task named \`${head}\``,
      hint: `look for a word under it that \`${head}\` does not take, or a comma that put an argument in the wrong place: a comma after a closed call or a literal stays at its level, and one after a word pops only that word. Keep every argument inside its call (\`back substring(one, 0, 1)\`), or put the arguments on their own indented lines`,
    }),
  )

  return undefined
}

// An identifier with its `{...}` TEMPLATE PARAMETERS dropped. A `{name}` in a name is filled when a `tree`
// expands, and one that survived expansion was never in a template, so the reader takes the name without it:
// `convert-to-{name}-space` is `convert-to--space`.
//
// A WHOLE PATH SEGMENT in braces is not a template parameter, it is a member read BY VALUE, `names/{at}`, and it
// is kept for `readPath` to index with. Stripped, a bare `back names/{at}` (the lean spelling of `read
// names/{at}`) emitted `return names.`, which is not TypeScript (2026-10-02, test/compile/silent-defects.ts).
function plainName(name: string): string {
  if (!name.includes('{')) {
    return name
  }

  return name
    .split('/')
    .map((segment, index) =>
      index > 0 && /^\{[^{}]+\}$/.test(segment)
        ? segment
        : segment.replace(/\{[^}]*\}/g, ''),
    )
    .join('/')
}

// A text literal, which is a STRING unless it carries an interpolation, and then it is a TEMPLATE: the chunks
// and the expressions between them, so `<n= {count}>` reads `count`.
//
// ONE BRACE SYNTAX, AND THE COMPILER DECIDES WHEN IT IS FILLED. `{x}` naming a template parameter was
// substituted when the `tree` expanded, before this ran. `{x}` naming a module constant that folds is filled at
// COMPILE time, by the simplifier (ir/simplify.ts, `fillTemplates`), so the output is a plain literal. Anything
// else is filled at RUN time: a template literal on TypeScript, `format!` on Rust, `\(x)` on Swift, `$x` on
// Kotlin. `{{x}}` is the older spelling of the same thing and is read the same way. A name that names nothing is
// the checker's unknown name, as anywhere else.
function textExpression(
  bridge: Bridge,
  value: Minted,
  span: Span,
): Expression {
  const node = value.node

  if (node?.kind !== 'text') {
    return { form: 'string', value: textOf(value) ?? '', span }
  }

  const braced = partsOf(node).find(part => part.kind === 'interpolation')

  if (!braced) {
    return { form: 'string', value: textOf(value) ?? '', span }
  }

  const parts: TemplatePart[] = []

  for (const part of partsOf(node)) {
    if (part.kind === 'chunk') {
      parts.push(chunkPart(unescapeText(part.text)))
      continue
    }

    if (part.kind !== 'interpolation' || !isGroup(part.group)) {
      continue
    }

    // `<{123}>`: a whole number alone in braces is its own digits, written into the text at compile time
    const only = part.group.nodes.length === 1 ? part.group.nodes[0] : undefined

    if (only?.kind === 'integer') {
      parts.push(chunkPart(only.text))
      continue
    }

    // what the braces hold is read THROUGH THE GRAMMAR, the way the same words read on a line, so `{n/text()}` is
    // the method call there too. A single word holding a `/` was read as a bare path here first, and a method's
    // call was dropped in silence: `${n.text}`, "value undefined" (test/compile/interpolated-call.ts, 2026-10-04).
    // The parser keeps no `()`, so only the grammar's own reading can tell a field from a method. The path is the
    // fallback for a group the grammar does not read
    const head = headWord(part.group)
    const inner =
      expressionFromNode(bridge, part.group, span) ??
      (head !== undefined && head.includes('/') && part.group.nodes.length === 1 ? readPath(head, span) : undefined)

    if (inner) {
      parts.push(valuePart(inner))
    }
  }

  return { form: 'template', parts, span }
}

// ---- types ----

const named = (name: string): Type => typeOfWord(name)

// A `like` names a type and carries its parts: applied arguments ride in the name as a phrase
// (`like stack number`), an element or key/value rides as a nested `like`, and a task type carries its
// parameters as `take` lines plus its result as the nested `like`.
// a list type, however it was written: `like list, like text` is an array, and a bare `like list` read as a phrase
// is the named type `list`
function isListType(type: Type | undefined): boolean {
  return type?.kind === 'array' || (type?.kind === 'named' && type.name === 'list')
}

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
    return { kind: 'array', element: children[0] ?? freeUnknownType() }
  }

  if (name === 'hash') {
    // THE ONE-LINE SPELLING, `like hash, like text, like number`: each comma nests the next `like` under the one
    // before, so the value arrives as the KEY's own child, and was read as `text` applied to `number` with the value
    // left free. Inference then filled it from a use when there was one and left it free when there was not, so a
    // native backend emitted `SeedMap<String, T>` (deck/make/test/affected.tree on Swift, 2026-10-04). A key that is
    // a primitive takes no argument, so a `like` under it can only be the hash's value
    const only = children.length === 1 ? at(value, 'child')[0] : undefined
    const keyWord = only && isForm(only) ? wordAt(only, 'name') : undefined
    const keyBase = keyWord !== undefined && !keyWord.includes(' ') && isTypeName(keyWord) ? typeOfWord(keyWord) : undefined
    const spilled = only && isForm(only) ? at(only, 'child') : []

    if (keyBase && keyBase.kind !== 'named' && spilled.length === 1) {
      return { kind: 'map', key: keyBase, value: typeOf(bridge, spilled[0]) ?? freeUnknownType() }
    }

    return {
      kind: 'map',
      key: children[0] ?? freeUnknownType(),
      value: children[1] ?? freeUnknownType(),
    }
  }

  if (name === 'task') {
    const params: Type[] = []
    // `''` for a parameter with no name (compile/node.ts, `paramNames`)
    const paramNames: string[] = []

    for (const take of formsAt(value, 'take')) {
      params.push(
        withHeadArgs(bridge, typeOf(bridge, firstAt(take, 'like')), take) ??
          unknownType(),
      )
      paramNames.push(wordAt(take, 'name') ?? '')
    }

    // EFFECTS on a callback type: `mark async` makes it async (`wait true` is the older spelling), and a bare `halt`
    // makes it one that may raise. They belong to the type, so a caller knows what the callback it is handed can do.
    const effects: string[] = []

    if (marked(value, 'async') || waitsTrue(value)) {
      effects.push('async')
    }

    if (at(value, 'halt').length > 0) {
      effects.push('throw')
    }

    return {
      kind: 'function',
      params,
      result: children[0] ?? unitType(),
      ...(paramNames.some(Boolean) ? { paramNames } : {}),
      ...(effects.length > 0 ? { effects } : {}),
    }
  }

  const base = isTypeName(name) ? typeOfWord(name) : undefined

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
    take => typeOf(bridge, firstAt(take, 'like')) ?? unknownType(),
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
        ? { form: 'float', value: Number(value.value), span }
        : integerLiteral(value.value, span)
    case 'word':
      // a bare word in value position is `true`, `false`, `void`, or a name
      if (value.value === 'true' || value.value === 'false') {
        return { form: 'boolean', value: value.value === 'true', span }
      }

      // `void` reaches here as a word from a lean call's argument list (`is-equal found, void`), where the
      // longhand's `seed` site would have carried it as the literal. A variable cannot be called `void`.
      if (value.value === 'void') {
        return { form: 'unit', span }
      }

      // `f()` is a call with no arguments. The generic tree has no node for an empty pair of parentheses, so
      // `f()` parsed exactly as `f` and milled to the bare name: `save b, make-box()` saved the TASK and emitted
      // `makeBox.size` (found porting compile/view-cap, 2026-10-02). The parentheses survive only in the token
      // stream, so that is where they are read.
      if (value.node && hasEmptyParens(value.node)) {
        return {
          form: 'call',
          callee: readPath(plainName(value.value), span),
          args: [],
          span,
        }
      }

      // a braced segment, `x/{k}` or a path after a call, `greeting()/text`, is read from the name's parts
      if (nameNodeOf(value.node)?.parts.some(part => part.kind === 'interpolation')) {
        const dynamic = dynamicPath(bridge, value, span)

        if (dynamic) {
          return dynamic
        }
      }

      // THROUGH readPath, so `x/a` in value position is a member read and not a variable named "x/a". The
      // callee slot always went through it and the value slot did not, so `letters/flat-map` as a head
      // worked and `x/a` as an argument resolved to nothing and said nothing (lean-0019, probed 2026-09-12).
      // Under lean a bare word is the ordinary way to name a value, so this stopped being a corner.
      return readPath(plainName(value.value), span)
    case 'form':
      break
  }

  // A VALUE WORD STANDING ALONE. `text`, `code` and `term` head a literal, and the grammar takes the head as one
  // whether or not a literal follows it, so a bare `term` was the empty text and a bare `code` was zero. Where a
  // parameter or a local of that name is in scope, that was the wrong reading with no message: `back term`, with
  // `term` a parameter, compiled to `return ""` (2026-10-02, test/compile/silent-defects.ts). So the local wins,
  // as a bare word means a variable everywhere else, and the same goes for every other value word the grammar
  // reads as a construct with nothing after it (`read`, `loan`, `make`, `task`, `meet`). With no such local, in a
  // body, the three literal words are refused rather than guessed at, naming both spellings.
  const lone = loneValueWord(value)

  if (lone !== undefined) {
    if (inScope(bridge, lone)) {
      return readPath(lone, span)
    }

    const literal = LITERAL_WORDS[lone]

    // only in a body, where the locals are known. At the top level of a file there are none to mistake, and a bare
    // word there keeps the reading it always had.
    if (literal !== undefined && bridge.inBody) {
      return refuse(
        bridge,
        value,
        `a bare \`${lone}\` is not a value: no local named \`${lone}\` is in scope here. Write \`read ${lone}\` for a variable named \`${lone}\`, or ${literal}`,
      )
    }
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
        const dynamic = dynamicPath(bridge, value, span)

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
          ? { form: 'float', value: Number(literal.value), span: spanOf(literal) }
          : integerLiteral(literal.value, spanOf(literal))
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

      return built?.form === 'if'
        ? asConditional(bridge, built, span)
        : undefined
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

    // `wait <call>` as a PREFIX, which is what `call f / ... / wait true` writes today. Decidable with no
    // schema, so it is outside the lean mark and every file gets it: `wait do-x` is the same text whether the
    // file is lean or not, since it is a prefix over a call and both call spellings are calls. lean-0031.
    case 'seed-wait': {
      const awaited =
        expressionOf(bridge, firstAt(value, 'call')) ??
        expressionOf(bridge, firstAt(value, 'open'))

      if (!awaited) {
        return unhandled(bridge, value, 'a wait with nothing to await')
      }

      return { form: 'await', expr: awaited, span }
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

      // THE COMMA TRAP. A bare head is a call, so a STATEMENT head whose own grammar rule refused the line arrives
      // here as a callee and the failure is reported as `the name "fork" is not defined`, pointing at the whole
      // line with nothing wrong on it. Usually a comma popped out of an inline construction and left the statement
      // head holding one argument too many. A statement word never names a task, so this holds in a longhand file
      // as much as a lean one: there the whole statement cascaded into `the name "fork"`, `"test"`, `"back"` is
      // not defined, one per word, and the one line the grammar could not read was not named (guides:
      // language/syntax, 2026-10-04). `host` is the one statement word a task may also be named, and where the file
      // has such a task, `host(routes, url)` is its call
      const word = plainName(callee)

      if (FLOW_HEADS.has(word) && !(word === 'host' && bridge.hostTask)) {
        return commaTrap(bridge, value, word, span)
      }

      // A BUILTIN HAS NO PARAMETER NAMES, so a bare-head child under one is a nested call, never a label. It
      // used to become a named argument whose value is an array, which `foldBuiltin` folded as an operand.
      // Found porting range.tree to lean (lean-0011).
      if (
        isLean(bridge, 'seed-call-open') &&
        (isBinaryBuiltin(plainName(callee)) ||
          isUnaryBuiltin(plainName(callee)))
      ) {
        const args: Expression[] = []

        for (const seed of at(value, 'seed')) {
          const built = expressionOf(bridge, seed)

          if (built) {
            args.push(built)
          }
        }

        return (
          foldBuiltin(plainName(callee), args, span) ?? {
            form: 'call',
            callee: readPath(plainName(callee), span),
            args,
            span,
          }
        )
      }

      // The same modifiers `call` reads, so a piped, awaited, propagating or callback-taking call means one
      // thing in both spellings. lean-0030.
      refuseHooks(bridge, value)

      const propagate = formsAt(value, 'halt').some(
        halt => wordAt(halt, 'mode') === 'kink',
      )
      const background = formsAt(value, 'wait').some(
        wait => wordAt(wait, 'seed') === 'false',
      )
      const awaited = formsAt(value, 'wait').some(
        wait => wordAt(wait, 'seed') === 'true',
      )
      const into =
        plainName(callee) === 'fill' || plainName(callee) === 'melt'
          ? typeOf(bridge, firstAt(value, 'like'))
          : undefined

      const finish = (call: Expression): Expression =>
        withLinks(bridge, awaited ? { form: 'await', expr: call, span } : call, value)

      // the lean surface: property heads among the arguments become labels. Written order is kept the way
      // `callOf` keeps it, by numbering the call's own children out of the parse tree.
      if (isLean(bridge, 'seed-call-open')) {
        const order = new Map<Node, number>()

        if (value.node?.kind === 'group') {
          value.node.nodes.forEach((child, index) => order.set(child, index))
        }

        // the `bind` SITE, which this rule gained with the other call modifiers: an explicit `bind name, value`
        // is a named argument here exactly as it is under `call`
        const written = [
          ...bindArguments(bridge, value, order),
          ...leanArguments(bridge, value, order),
        ].sort((a, b) => a.at - b.at)
        const args = written.map(entry => entry.expr)
        // `''` for a positional argument (compile/node.ts, `names`)
        const names = written.map(entry => entry.name ?? '')
        const leanNames = written.map(entry => entry.lean === true)

        const folded = foldBuiltin(plainName(callee), args, span)

        return finish(
          folded ??
            (into
              ? // `fill` / `melt` carry the lean markers too, so a nested call written bare under one is a call
                // rather than a label nobody resolves (deck/base/code/native/webview/file.tree, `fill /
                // data-from-text as-text(reply) / like path-info`, pnpm term:lean-equal 2026-10-02)
                ({
                  form: 'call',
                  callee: readPath(`${plainName(callee)}-form`, span),
                  args,
                  into,
                  span,
                  ...(names.some(Boolean) ? { names } : {}),
                  ...(leanNames.some(Boolean) ? { leanNames } : {}),
                  lean: true,
                } as Expression)
              : ({
                  form: 'call',
                  callee: readPath(plainName(callee), span),
                  args,
                  span,
                  ...(names.some(Boolean) ? { names } : {}),
                  ...(leanNames.some(Boolean) ? { leanNames } : {}),
                  lean: true,
                  ...(propagate ? { propagate: true } : {}),
                  ...(background ? { background: true } : {}),
                } as Expression)),
        )
      }

      const plainOrder = new Map<Node, number>()

      if (value.node?.kind === 'group') {
        value.node.nodes.forEach((child, index) =>
          plainOrder.set(child, index),
        )
      }

      // the `bind` SITE, which this rule gained with the other call modifiers. A `bind` KEEPS ITS NAME here, as it
      // does under `call`, so the checker places the value by the callee's declared parameters. Until 2026-10-02 it
      // dropped the name outside lean (parity with the old reader), and `gap / bind height, 3 / bind width, 4`
      // passed 3 as the width and 4 as the height: -1 where `call gap` gave 1, with no message.
      const loose = bindArguments(bridge, value, plainOrder)

      for (const seed of at(value, 'seed')) {
        const index = seed.node
          ? (plainOrder.get(seed.node) ?? loose.length)
          : loose.length
        const named =
          seed.kind === 'form' && seed.form === 'seed-bind-arg'
            ? bindArgLabel(seed)
            : undefined
        const built = expressionOf(bridge, seed)

        if (built) {
          loose.push({ at: index, expr: built, name: named })
        }
      }

      const sorted = loose.sort((a, b) => a.at - b.at)
      const args = sorted.map(entry => entry.expr)
      const looseNames = sorted.map(entry => entry.name ?? '')

      // the arithmetic, comparison and boolean builtins fold to an operator here as they do under `call`:
      // `and a, b` is `a && b`, not a call to something named `and`. Probed 2026-09-12 that it was not
      // (note/term/lean.md, "meet and becomes and"), and the fold was only ever run from callOf.
      const plain = foldBuiltin(plainName(callee), args, span)

      return finish(
        plain ??
          (into
            ? ({ form: 'call', callee: readPath(`${plainName(callee)}-form`, span), args, into, span } as Expression)
            : ({
                form: 'call',
                callee: readPath(plainName(callee), span),
                args,
                span,
                ...(looseNames.some(Boolean) ? { names: looseNames } : {}),
                ...(propagate ? { propagate: true } : {}),
                ...(background ? { background: true } : {}),
              } as Expression)),
      )
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

  // the lean surface: `make x / foo true / bar <baz>` fills the fields `foo` and `bar`. A property head among
  // the positionals is a field, built as an array the checker unwraps against the field's declared type; the
  // rest stay positional and fill the form's slots as they do today.
  //
  // NOT for `make list` or `make find`: an array and a native map have no fields, so every child is an ELEMENT.
  // Read with labels, `make list / text <a> / replace-all from, <->, <_>` built the record
  // `{ replaceAll: [...] }` where the list's second item belonged, and two items of one head were refused as a
  // field "given twice". Found by `pnpm term:lean-equal` on deck/zone/code (self-hosting-0013).
  const lean = isLean(bridge, 'make') && name !== 'list' && name !== 'find'

  if (lean) {
    const order = new Map<Node, number>()

    if (value.node?.kind === 'group') {
      value.node.nodes.forEach((child, index) => order.set(child, index))
    }

    for (const entry of leanArguments(bridge, value, order)) {
      if (entry.name !== undefined) {
        fields.push({ name: entry.name, value: entry.expr })
      } else {
        positional.push(entry.expr)
      }
    }
  } else {
    for (const seed of at(value, 'seed')) {
      const built = expressionOf(bridge, seed)

      if (built) {
        positional.push(built)
      }
    }
  }

  // values written UNDER the name: `make some(x)`, and `make some x`, which parses the same, since a space nests as a
  // parenthesis does. The grammar reads a construction's values beside its name (`make some, x`), so these were
  // dropped without a word: `make some(error)` built `{ form: "some", value: undefined }` on TypeScript, and a local
  // one-field case reached the kernel as an unapplied constructor (`expected maybe-number, found (many x1 : Number) ->
  // maybe-number`). Found by the time/compare port (self-hosting, 2026-10-04). Each is a positional value, filled
  // into the form's slots or a one-field case's field as a value beside the name is
  const named = value.node?.kind === 'group' ? value.node.nodes[1] : undefined

  if (named?.kind === 'group' && positional.length === 0) {
    for (const child of named.nodes.slice(1)) {
      // a literal (`80`, `<a>`) is mined as the bare node, which the `seed` rule reads as a literal at the root
      const built = expressionFromNode(bridge, child as GroupNode, spanOf(value))

      if (built) {
        positional.push(built)
      }
    }
  }

  // `make list` is the native array and `make hash` the native map, its entries `save <key>, <value>` lines. A
  // `make hash` with entries dropped them until 2026-10-05: it built the map empty, typed by nothing, while the same
  // lines under `make find` built them. `make find` was a second spelling of the same map, and is refused by name
  if (name === 'list' && fields.length === 0) {
    return { form: 'array', items: positional, span: spanOf(value) }
  }

  // with `bind` lines it builds a program's own `find` (the hold grammar's `mint find, like code-find`), as any form
  if (name === 'find' && fields.length === 0) {
    return refuse(bridge, value, '`make find` is the older spelling of `make hash`. Write `make hash`, with the same `save <key>, <value>` lines under it')
  }

  // A `bind` under `make hash` builds a program's OWN `hash`: @term/host's `data` has `case hash / link list`. With
  // no form or case of that name it is refused where every such `make` is (check/type-names.ts), so the native map
  // takes only `save` entries
  if (name === 'hash' && fields.length === 0) {
    // a key is the `save` line's word, or under `save-key` any value: a text with a space, a capital or a leading
    // digit, or a computed one (`<{k}>`), which the word cannot be (decisions-2026-10.md, D14)
    const entries = formsAt(value, 'save').map(entry => ({
      key: (firstAt(entry, 'key') ? expressionOf(bridge, firstAt(entry, 'key')) : undefined) ?? {
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
      ...(lean ? { lean: true } : {}),
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
  // the parameters are in scope in the body, for `inScope` only: the body's `save`s still declare, as they did.
  // AND THE BODY IS ITS OWN SCOPE, as the legacy mill gives it (`new Set(scope)`): a name the enclosing body declared
  // is still assigned, since a closure captures it, but a name the closure declares stays the closure's. Without the
  // copy two handlers in one task that each `save value` leaked into each other: the second `save` became an
  // assignment to the first handler's local, and every read of it failed as "not defined" (native-text-0003)
  const outer = bridge.bound
  const enclosing = bridge.declared
  bridge.bound = new Set([...outer, ...params.map(p => p.name)])
  bridge.declared = new Set(enclosing)
  const body = flowOf(bridge, bodySteps(bridge, value))
  bridge.bound = outer
  bridge.declared = enclosing

  return {
    form: 'closure',
    params,
    body,
    ...(result ? { result } : {}),
    // a closure is async the same two ways a task is: `note async`, or a `wait true` on the definition
    ...(marked(value, 'async') || waitsTrue(value) ? { async: true } : {}),
    span: spanOf(value),
  }
}

// A VALUE-POSITION FORK IS AN EXPRESSION, so each of its arms is one value and has nowhere to put a statement.
// An arm that holds one anyway used to make this return `undefined`, the caller drop the whole fork, and the
// backend emit `undefined` as the value: every augmented athematic form came out `undefinedasmi` and every
// absolutive read "having undefined", both clean builds. Say what the arm did instead, and name the statement.
function asConditional(
  bridge: Bridge,
  built: Extract<Statement, { form: 'if' }>,
  span: Span,
): Expression | undefined {
  const branches: { cond: Expression; value: Expression }[] = []

  const refuse = (at: Span, what: string): undefined => {
    bridge.diagnostics.push(
      diagnose('unexpected-node', {
        file: bridge.file,
        span: at,
        message: `a fork in value position is one value per arm, and this arm ${what}`,
        hint: 'bind the value first (`save x` before the fork, and each arm a plain value), or make the fork a statement whose arms each `send back`',
      }),
    )

    return undefined
  }

  for (const branch of built.branches) {
    const only = branch.body[0]

    if (branch.body.length === 0) {
      return refuse(branch.cond.span, 'is empty')
    }

    if (branch.body.length > 1) {
      return refuse(
        branch.body[1]!.span,
        `holds ${branch.body.length} statements`,
      )
    }

    if (only?.form !== 'expression') {
      return refuse(only!.span, `holds a \`${only!.form}\` statement`)
    }

    branches.push({ cond: branch.cond, value: only.expr })
  }

  let otherwise: Expression | undefined

  if (built.otherwise) {
    const last = built.otherwise[0]

    if (built.otherwise.length > 1) {
      return refuse(
        built.otherwise[1]!.span,
        `holds ${built.otherwise.length} statements`,
      )
    }

    if (last?.form === 'expression') {
      otherwise = last.expr
    } else if (last?.form === 'if') {
      // an else-if chain: the else is another conditional, carried in value position too
      otherwise = asConditional(bridge, last, last.span)

      if (!otherwise) {
        return undefined
      }
    } else if (last) {
      return refuse(last.span, `holds a \`${last.form}\` statement`)
    }
  }

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

    if (found && partsOf(found).some(part => part.kind === 'interpolation')) {
      return found
    }
  }

  return undefined
}

// A path with an interpolated segment, built from the token's parts the way the mill builds it: each chunk
// contributes plain segments, and each `{...}` contributes a member indexed by the inner group's value.
function dynamicPath(bridge: Bridge, value: Minted, span: Span): Expression | undefined {
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

  for (const part of partsOf(head)) {
    if (part.kind === 'chunk') {
      for (const segment of part.text.split('/').filter(s => s.length > 0)) {
        step(segment)
      }

      continue
    }

    if (!isGroup(part.group)) {
      continue
    }

    // a path that STARTS with a braced value is rooted at that value, which is how `greeting()/text` reads (the
    // parser builds it as `{greeting()}/text`): the field of what the call returns
    if (!built) {
      built = expressionFromNode(bridge, part.group, spanOfWhole(part.group))

      if (!built) {
        return undefined
      }

      continue
    }

    // the segment's WHOLE value, as the root above reads it. It was the group's first word as a variable, so
    // `grid/{multiply(i, 2)}` indexed by the task `multiply` itself, which every check accepted as a value, and the
    // call was dropped in silence (pair-diagnostic, test/compile/computed-key.ts, 2026-10-05)
    const index = expressionFromNode(bridge, part.group, spanOfWhole(part.group))

    if (!index) {
      return undefined
    }

    built = { form: 'member', target: built, name: '', index, span }
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

// The tag field a form names with `mark tag, name kind`, or undefined for the default, `form`
function tagOf(value: Form): string | undefined {
  const mark = formsAt(value, 'mark').find(m => wordAt(m, 'kind') === 'tag')
  const name = mark ? (wordAt(firstAt(mark, 'name'), 'name') ?? wordAt(mark, 'name')) : undefined

  return name && name !== 'form' ? name : undefined
}

// Is this word written with an empty pair of parentheses straight after it, `f()`. The tree keeps no node for
// them, so the word's last chunk says what followed its token (`follows`, read off the token list by the parser).
function hasEmptyParens(node: Node): boolean {
  const name =
    node.kind === 'name'
      ? node
      : node.kind === 'group' && node.nodes.length === 1 && node.nodes[0]?.kind === 'name'
        ? node.nodes[0]
        : undefined
  const last = name?.parts[name.parts.length - 1]

  return last?.kind === 'chunk' && last.follows === 'empty-parens'
}

// The forms a value word builds when it stands alone, by the word that heads each. A bare `meet` is the empty
// conjunction, a bare `make` a record with no name, a bare `task` a closure with no body, a bare `read` the empty
// path: each is a construct with nothing in it, and a local of that name is what a person writing the word meant.
const VALUE_WORD_FORMS: Record<string, string> = {
  'seed-text': 'text',
  'seed-code': 'code',
  'seed-term': 'term',
  'seed-read': 'read',
  'seed-loan': 'loan',
  read: 'read',
  make: 'make',
  task: 'task',
  'seed-meet': 'meet',
}

// The three that head a literal, and the literal to write instead.
const LITERAL_WORDS: Record<string, string> = {
  text: '`<>` for the empty text',
  code: '`0` for zero',
  term: '`term <word>` for a word as a value',
}

// The word, when this construct is its head word written alone: no literal, no name, no child.
function loneValueWord(value: Form): string | undefined {
  const word = VALUE_WORD_FORMS[value.form]
  const node = value.node
  const alone =
    node?.kind === 'name' ||
    (node?.kind === 'group' &&
      node.nodes.length === 1 &&
      node.nodes[0]?.kind === 'name')

  return word !== undefined && alone && wordOf(node) === word && !hasEmptyParens(node!)
    ? word
    : undefined
}

// Is this word written with a parenthesis straight after it, `host(`. Read off the token stream, as
// `hasEmptyParens` reads `f()`.
function opensParen(node: Node | undefined): boolean {
  const last = node?.kind === 'name' ? node.parts[node.parts.length - 1] : undefined

  if (last?.kind !== 'chunk') {
    return false
  }

  return last.follows !== undefined
}

// The names the file defines or imports that a body line may call: `task x` and `view x` at the top level, and
// `find x` (or a `find y, name x`) under a `load`. Read off the parse tree before anything mints, because a call in
// a body can sit above the definition it calls. Two readers ask it: whether a `host` statement is the task of that
// name, and whether a line the grammar matched as the binding dialect's vocabulary (`home`, `rank`, `time`, ...,
// code/drop/mine.tree) is a call after all
function namesInFile(tree: RootNode): Set<string> {
  const names = new Set<string>()
  const add = (node: Node | undefined): void => {
    const word = wordOf(node)

    if (word !== undefined) {
      names.add(word)
    }
  }

  for (const group of tree.nodes) {
    if (group.kind !== 'group') {
      continue
    }

    const head = headWord(group)

    if (head === 'task' || head === 'view') {
      add(group.nodes[1])
      continue
    }

    if (head !== 'load') {
      continue
    }

    for (const child of group.nodes) {
      if (child.kind !== 'group' || headWord(child) !== 'find') {
        continue
      }

      // `find x, name y` imports x under the local name y, so only the alias counts
      const alias = child.nodes.find(
        (part): part is GroupNode =>
          part.kind === 'group' && headWord(part) === 'name',
      )

      add(alias ? alias.nodes[1] : child.nodes[1])
    }
  }

  return names
}

// ---- the lean surface ----

// Does this construct take lean labels in this file: the file's role is marked lean AND the grammar rule that
// read the construct carries `mark lean`. Both, so a lean file still reads a `take` or a `walk` as itself.
function isLean(bridge: Bridge, rule: string): boolean {
  return bridge.lean === true && bridge.grammar.lean?.has(rule) === true
}

// One argument as it was written, with where it sat among the construct's children so a label written before a
// positional argument stays before it. `callOf` invented this ordering for `bind`; the lean partition shares it.
// `lean` marks a label that came from a PROPERTY HEAD rather than an explicit `bind`: the checker refuses to
// drop the first kind and treats the second as documentation, as it always did.
type Written = { at: number; expr: Expression; name: string | undefined; lean?: boolean }

// The lean partition of a construct's `seed` captures. A capture that is itself a bare-head call with a plain
// name is a NAMED argument: the head is the label and its own arguments are the value, built as an ARRAY so the
// checker can decide by the parameter's declared type whether it is one value or a list. Anything else stays
// positional and is built exactly as it would be without lean.
//
// A bare word stays a VARIABLE here, on purpose. Whether `strict` under a call is a flag or a value depends on
// whether the callee has a boolean parameter called `strict`, and the mill has no callee to ask. The checker
// does: `arrangeArguments` turns a positional variable that names an unfilled boolean parameter into that label
// set to true. Position first, then the name, with the schema where the schema is.
//
// The explicit `bind name, value` site, as a named argument. `callOf` has read it forever; `seed-call-open`
// gained the site with the other call modifiers (lean-0030) and needs the same reading, or the argument is
// captured there and never built. The name is KEPT in every file, lean or not, exactly as under `call`: a bare
// head over `bind` lines is the same call as `call` over them. Outside lean it used to be dropped, so the values
// went in written order whatever their names said (2026-10-02, test/compile/silent-defects.ts).
function bindArguments(
  bridge: Bridge,
  value: Form,
  order: Map<Node, number>,
): Written[] {
  const written: Written[] = []

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

  return written
}

// The label of a `seed-bind-arg`. `mine seed-bind-arg` matches the name as a bare node, so it is read off the CST.
function bindArgLabel(seed: Form): string | undefined {
  return seed.node?.kind === 'group' && seed.node.nodes[1]?.kind === 'group'
    ? wordOf(seed.node.nodes[1].nodes[0])
    : undefined
}

function leanArguments(
  bridge: Bridge,
  value: Form,
  order: Map<Node, number>,
): Written[] {
  const written: Written[] = []

  for (const seed of at(value, 'seed')) {
    const index = seed.node ? (order.get(seed.node) ?? written.length) : written.length

    if (seed.kind === 'form' && seed.form === 'seed-call-open') {
      const head = wordAt(seed, 'name')
      // A property head carrying a CALL MODIFIER is a call, never a label: a label's value takes no `wait`,
      // passes no exception on, and names no arguments of its own with `bind`. Read as a label, `source-lines
      // file, wait true` lost its await, and `read-env / bind name, <ZONE_SAVE>` under another call lost BOTH its
      // arguments, because only a property's plain children become its value. So the modifier decides it here,
      // structurally, before any schema is consulted. Both found by `pnpm term:lean-equal` (self-hosting-0013).
      const modified =
        formsAt(seed, 'wait').length > 0 ||
        formsAt(seed, 'halt').length > 0 ||
        formsAt(seed, 'bind').length > 0

      if (head !== undefined && !head.includes('/') && !modified) {
        const items: Expression[] = []

        for (const inner of at(seed, 'seed')) {
          const built = expressionOf(bridge, inner)

          if (built) {
            items.push(built)
          }
        }

        written.push({
          at: index,
          name: plainName(head),
          expr: { form: 'array', items, span: spanOf(seed) },
          lean: true,
        })
        continue
      }
    }

    if (seed.kind === 'form' && seed.form === 'seed-bind-arg') {
      // the name is the first child; `mine seed-bind-arg` matches it as a bare node, so read it off the CST
      const label = bindArgLabel(seed)
      const built = expressionOf(bridge, firstAt(seed, 'seed'))

      if (built) {
        written.push({ at: index, name: label, expr: built })
        continue
      }
    }

    const built = expressionOf(bridge, seed)

    if (built) {
      written.push({ at: index, name: undefined, expr: built })
    }
  }

  return written
}

// A `hook` under a call is not a callback: the bridge reads none, so the whole thing used to be dropped with
// no message. An anonymous `task` IS the callback spelling and keeps its parameters. lean-0015.
function refuseHooks(bridge: Bridge, value: Form): void {
  // A `wait` under a call is the await MARKER, `wait true` or `wait false`. With anything else after it (`wait
  // f(x)`, an awaited call written as the next line of a stacked call) the call read it as a marker that is
  // neither, and the awaited call was dropped with no message, the way it was under a task.
  for (const wait of formsAt(value, 'wait')) {
    const word = wordAt(wait, 'seed')

    if (word !== 'true' && word !== 'false') {
      bridge.diagnostics.push(
        diagnose('unexpected-node', {
          file: bridge.file,
          span: spanOf(wait),
          message: 'a `wait` under a call marks the call itself and takes `true` or `false`, so this would be dropped',
          hint: 'await the other call first, `save x, wait f(y)`, and pass `x`',
        }),
      )
    }
  }

  for (const hook of formsAt(value, 'hook')) {
    bridge.diagnostics.push(
      diagnose('unexpected-node', {
        file: bridge.file,
        span: spanOf(hook),
        message: 'a `hook` under a call is not read as an argument, so this would be dropped',
        hint: 'write the callback as an anonymous task: `task` on its own line, with its `take` parameters and body indented under it',
      }),
    )
  }
}

// A NAMED task directly under a task, or under a walk's `hook next`, lands in that form's `task` site rather
// than its body, and used to be dropped in silence. The language has no nested named task (a task is defined at
// the top level, and a local function is a closure in value position), so it is refused, exactly as the checker
// refuses one that reaches a body through a fork arm (check/infer.ts, where it used to crash).
function refuseNestedTasks(bridge: Bridge, value: Form): void {
  for (const nested of formsAt(value, 'task')) {
    const name = wordAt(nested, 'name')

    if (name !== undefined) {
      bridge.diagnostics.push(
        diagnose('unexpected-node', {
          file: bridge.file,
          span: spanOf(nested),
          message: `\`task ${name}\` cannot be defined inside a body: a named task is defined at the top level of a file`,
          hint: 'move it to the top level of the file and call it from here',
        }),
      )
    }
  }
}

// A `take`, `link` or `slot` has ONE type, its first `like`. A second `like` at the same depth is read only as a
// FUNCTION's result (`take f, like task / take x, like nat / like nat`, see withOuterTakes), so under any other type
// it was read by nothing: `take tells / like list / like dynamic` was a list of anything with no message, and the
// element type the author wrote went nowhere. A type argument nests under its type, or follows it on one line:
// `take tells, like list, like dynamic`, where the comma puts the second `like` under the first. On a `take` the
// second one lands at `like`, on a link at `result`; a link with a native `name <X>` ignores its trailing `like` by
// design (quirk 6), so it is not refused there.
function refuseSiblingLikes(bridge: Bridge, value: Form, declared: Type | undefined): void {
  const extras = [...formsAt(value, 'like').slice(1), ...formsAt(value, 'result')]

  if (extras.length === 0 || declared?.kind === 'function' || wordAt(value, 'nick') !== undefined) {
    return
  }

  for (const extra of extras) {
    bridge.diagnostics.push(
      diagnose('unexpected-node', {
        file: bridge.file,
        span: spanOf(extra),
        message: 'a second `like` beside the first is read by nothing: a parameter or field has one type',
        hint: 'nest the type argument under its type, or write it on one line: `take x, like list, like text`',
      }),
    )
  }
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

  const written: Written[] = []

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

  if (isLean(bridge, 'call')) {
    written.push(...leanArguments(bridge, value, order))
  } else {
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

  refuseHooks(bridge, value)

  written.sort((a, b) => a.at - b.at)

  const args = written.map(entry => entry.expr)
  // `''` for a positional argument (compile/node.ts, `names`)
  const names = written.map(entry => entry.name ?? '')
  // which labels came from a PROPERTY HEAD rather than a `bind`, exactly as the bare-head call records it. Without
  // this an explicit `call` under lean had labels the checker could not tell apart from `bind`s, so one on a
  // native callee (`call diagnostic-module/renderKink`) was dropped as documentation, in silence
  const leanNames = written.map(entry => entry.lean === true)

  // the arithmetic and comparison builtins lower to an operator, not a call: they have no definition to bind to
  const folded = foldBuiltin(name, args, span)

  // `halt kink` as a child of the call passes the callee's exception on rather than handling it here
  const propagate = formsAt(value, 'halt').some(
    halt => wordAt(halt, 'mode') === 'kink',
  )
  // `tick f(x)` is the call STARTED AND NOT WAITED FOR: minted as a call (call/mine.tree, `mine tick`) and told
  // apart here by its head word. `wait false` under a `call` is the older spelling of the same thing. Either is a
  // different thing from `wait true` and from no marker at all, which await a call to an async task.
  const ticked = value.node?.kind === 'group' && headWord(value.node) === 'tick'

  if (ticked) {
    for (const wait of formsAt(value, 'wait')) {
      bridge.diagnostics.push(
        diagnose('unexpected-node', {
          file: bridge.file,
          span: spanOf(wait),
          message: '`tick` starts the call and does not wait for it, so a `wait` under it says the opposite',
          hint: 'write the call without `tick` to wait for it, or drop the `wait` to start it and go on',
        }),
      )
    }
  }

  const background =
    ticked ||
    formsAt(value, 'wait').some(wait => wordAt(wait, 'seed') === 'false')
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
          ...(leanNames.some(Boolean) ? { leanNames } : {}),
          ...(isLean(bridge, 'call') ? { lean: true } : {}),
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
  const op = isBinaryBuiltin(name) ? binaryBuiltinOp(name) : undefined

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

  if (name === 'not' && args.length === 1) {
    return { form: 'unary', op: '!', operand: args[0]!, span }
  }

  return undefined
}

// ---- statements ----

function flowOf(bridge: Bridge, values: Minted[]): Statement[] {
  const body: Statement[] = []
  const renames: { at: number; from: string; to: string }[] = []

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
        '`halt take` is the handler of a guarded block and must follow one: `fork` with `mark unsafe` as its first line',
      )

      continue
    }

    // A BLOCK IS A `fork`, never a metadata word (2026-10-06). `mark unsafe` or `note unsafe` holding statements of its
    // own was the guarded block's spelling, and is refused by the one that replaced it: the note-guard mill rules still
    // read it, so the message can name the fix. `pnpm term:guard-migrate --commit` moved the repository
    if (
      isForm(value) &&
      value.form === 'note' &&
      wordAt(value, 'text') === 'unsafe' &&
      wordAt(value, 'opener') === undefined &&
      at(value, 'flow').length > 0
    ) {
      refuse(
        bridge,
        value,
        'a guarded block is a `fork` with `mark unsafe` on it: write `fork`, then `mark unsafe` as its first line and the statements under it. `mark unsafe` no longer opens a block',
      )

      // its handler belongs to the refused block, and is not a second mistake
      const next = values[i + 1]

      if (isForm(next) && next.form === 'halt' && wordAt(next, 'mode') === 'take') {
        i++
      }

      continue
    }

    // `fork` / `mark unsafe` over a body, with the `halt take` after it, is ONE guarded block: the note carries the
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
                body: scopedFlow(bridge, at(handler, 'flow'), [
                  wordAt(bound, 'name') ?? '',
                ]),
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

    bridge.shadowed = undefined
    const built = statementOf(bridge, value)

    if (Array.isArray(built)) {
      body.push(...built)
    } else if (built) {
      body.push(built)
    }

    // a `save` that read the name it declared took a fresh one (statementOf, `save`): every use after it is that
    if (bridge.shadowed) {
      renames.push({ at: body.length, ...bridge.shadowed })
      bridge.shadowed = undefined
    }
  }

  // each rename covers the statements after its own `save`, in order, so a later one sees the earlier one done
  let renamed = body

  for (const { at: from, from: name, to } of renames) {
    renamed = [...renamed.slice(0, from), ...renameLocal(renamed.slice(from), name, to)]
  }

  return renamed
}

// a nested body is its own scope: a `save x` in one arm of a fork must not turn the `save x` in the other arm
// into an assignment to a name that was never bound on that path
function scopedFlow(
  bridge: Bridge,
  values: Minted[],
  // names the body binds on entry: a walk's item, a case arm's `link` names, a handler's caught exception
  binds: readonly string[] = [],
): Statement[] {
  const enclosing = bridge.declared
  const outer = bridge.bound
  bridge.declared = new Set(enclosing)
  bridge.bound = new Set([...outer, ...binds])
  const body = flowOf(bridge, values)
  bridge.declared = enclosing
  bridge.bound = outer

  return body
}

// Every free reference to the local `from` in a built body, read or written, renamed `to`. A construct that binds
// `from` again (a closure's parameter, a walk's item or index, a nested task, a case arm's `link` names, a handler's
// caught name) starts a new scope where `from` is that binding, so nothing under it is renamed
function renameLocal<T>(value: T, from: string, to: string): T {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(visit)
    }

    if (node === null || typeof node !== 'object') {
      return node
    }

    const record = node as Record<string, unknown>

    if (record.form === 'variable' && record.name === from) {
      return { ...record, name: to }
    }

    const params = record.params as { name: string }[] | undefined
    const rebinds =
      (record.form === 'closure' || record.form === 'function') && params?.some(p => p.name === from)
        ? true
        : record.form === 'for-each' && (record.item === from || record.index === from)

    if (rebinds) {
      return node
    }

    const out: Record<string, unknown> = {}

    for (const [key, child] of Object.entries(record)) {
      if (key === 'span' || key === 'type' || key === 'binding') {
        out[key] = child
      } else if (key === 'cases' && Array.isArray(child)) {
        out[key] = child.map(arm =>
          (arm as { binds?: string[] }).binds?.includes(from) ? arm : visit(arm),
        )
      } else if (key === 'catch' && (child as { name?: string } | undefined)?.name === from) {
        out[key] = child
      } else {
        out[key] = visit(child)
      }
    }

    return out
  }

  return visit(value) as T
}

// does a built expression read the variable `name` anywhere in it
function readsVariable(expr: unknown, name: string): boolean {
  if (expr === null || typeof expr !== 'object') {
    return false
  }

  if (Array.isArray(expr)) {
    return expr.some(one => readsVariable(one, name))
  }

  const node = expr as Record<string, unknown>

  if (node.form === 'variable' && node.name === name) {
    return true
  }

  return Object.entries(node).some(([key, child]) => key !== 'span' && key !== 'type' && readsVariable(child, name))
}

// Is this name a local in scope here: a parameter, a `save`, or any other binder the bridge has passed.
function inScope(bridge: Bridge, name: string): boolean {
  return bridge.declared.has(name) || bridge.bound.has(name)
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

    // `save x, sift <value>`: `x` declared, then the `sift` statement with every arm that gives a value assigning it.
    // A declared `save x` is typed by its first assignment (check/infer.ts) and written with its type and no value on
    // each backend (`declaredLater`), which is what this needs (guides: language/matching, 2026-10-05)
    case 'save-match': {
      const name = wordAt(value, 'name')

      if (name === undefined) {
        return unhandled(bridge, value, 'a save with no name')
      }

      const built = matchOf(bridge, value)

      if (built?.form !== 'match') {
        return built
      }

      const existing = name.includes('/') || bridge.declared.has(name)
      bridge.declared.add(name)

      const assigning = (body: Statement[]): Statement[] => {
        const last = body[body.length - 1]

        return last?.form === 'expression'
          ? [...body.slice(0, -1), { form: 'assign', target: readPath(name, last.span), op: '=', value: last.expr, span: last.span }]
          : body
      }

      const match: Statement = {
        ...built,
        cases: built.cases.map(arm => ({ ...arm, body: assigning(arm.body) })),
        ...(built.otherwise ? { otherwise: assigning(built.otherwise) } : {}),
      }

      return existing ? match : [{ form: 'let', name, init: { form: 'unit', span }, mutable: true, span }, match]
    }

    // `back sift <value>`: the match, each arm returning the value it ends on. There is no match expression in the
    // IR, so it is the `sift` statement with a `return` put at the end of every arm that gives a value; an arm that
    // returns or raises itself is left as written (guides: language/matching, 2026-10-05)
    case 'back-match': {
      const built = matchOf(bridge, value)

      if (built?.form !== 'match') {
        return built
      }

      const returning = (body: Statement[]): Statement[] => {
        const last = body[body.length - 1]

        return last?.form === 'expression'
          ? [...body.slice(0, -1), { form: 'return', value: last.expr, span: last.span }]
          : body
      }

      return {
        ...built,
        cases: built.cases.map(arm => ({ ...arm, body: returning(arm.body) })),
        ...(built.otherwise ? { otherwise: returning(built.otherwise) } : {}),
      }
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
        // a braced segment (`save grid/{at}`) is read from the target's own parts, as a read of it is: through
        // `readPath` it was the segment's text as a variable name, so `save grid/{multiply(i, 2)}` wrote to
        // `grid[multiply]` (test/compile/computed-key.ts)
        const target = (name.includes('{') ? dynamicPath(bridge, value, span) : undefined) ?? readPath(name, span)

        return {
          form: 'assign',
          target,
          op: '=',
          value: init,
          span,
        }
      }

      bridge.declared.add(name)
      const declaredType = typeOf(bridge, firstAt(value, 'like'))

      // A NEW local whose value reads its own name reads something OUTSIDE this scope: a `fork case` arm's field, a
      // module constant. `save callee, rewrite(callee)` under `case call` meant the field, and declaring `callee`
      // first made the value read the new local before it existed: a TypeError on TypeScript, and every compile of
      // the ported simplifier stopped there (2026-10-06). The new local takes a fresh name, the value keeps reading
      // the outer one, and `flowOf` renames the uses after it
      const fresh = readsVariable(init, name) ? `${name}__${(bridge.shadows = (bridge.shadows ?? 0) + 1)}` : undefined

      if (fresh) {
        bridge.shadowed = { from: name, to: fresh }
      }

      return {
        form: 'let',
        name: fresh ?? name,
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

    // `wait f(x)` as a STATEMENT. Under a task it arrives as the task's own `wait` site (`bodySteps` puts it back
    // in written order), and anywhere else as the value rule's prefix. Both await the call and keep it.
    case 'wait': {
      const awaited = expressionOf(bridge, firstAt(value, 'seed'))

      if (!awaited) {
        return refuse(bridge, value, '`wait` here has nothing to await: write `wait f(x)` with the call after it')
      }

      return {
        form: 'expression',
        expr: awaited.form === 'await' ? awaited : { form: 'await', expr: awaited, span },
        span,
      }
    }

    case 'seed-wait': {
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

    case 'turn': {
      // `turn next, name outer` continues the loop named `outer`
      const label = wordAt(value, 'name')

      return { form: 'continue', ...(label ? { label } : {}), span }
    }

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
  // `halt, name outer` breaks out of the loop named `outer`
  const label = wordAt(value, 'name')

  if (label !== undefined && (mode !== undefined || firstAt(value, 'seed') !== undefined)) {
    return refuse(bridge, value, '`halt, name <loop>` breaks out of a named loop and takes nothing else. Raise with `halt <form>` on its own line')
  }

  if (mode === undefined) {
    const raised = expressionOf(bridge, firstAt(value, 'seed'))

    return raised
      ? { form: 'throw', value: raised, span }
      : { form: 'break', ...(label ? { label } : {}), span }
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

// The three walk modes, and the whole of them. A first term outside this set is the sequence, which is what
// makes the mode optional: `walk one/stem` is `walk list, read one/stem`.
const WALK_MODES = new Set(['list', 'size', 'test'])

// The heads a `walk test` lets stand directly under it, besides its body: the arms and a contract, and `bind` /
// `take`, which the walk rule matches for its other two modes. A `walk test` still ignores those two, as it did;
// refusing them is a separate decision from this one.
const WALK_TEST_PARTS = new Set(['hook', 'must', 'down', 'bind', 'take'])

// the marks a task takes, each read by something: `async`, `private` and `roam` here, `open` on a claim, `unsafe` as a
// guard, `deprecated` by check/deprecated.ts. `exact`, the opt-in overflow proof (note/term/gaps/plan.md), joins when
// something reads it.
const TASK_MARKS = new Set(['async', 'private', 'roam', 'open', 'unsafe', 'deprecated'])

// the marks that belong to a FILE, unindented at its top level: `draft` is read by the build walk before anything
// parses (call/code/draft.ts), `stable` and `unstable` by `pnpm term:base-marks`. Under a task they were accepted and
// read by nothing (guides: language/notes, 2026-10-04)
const FILE_MARKS = new Set(['draft', 'stable', 'unstable'])

// the width aliases of `number` whose range a literal argument is held to (check/literals.ts)
const WIDTH_WORDS = new Set(['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64'])

// the type parameter a mask's default task is generic over: the form wearing the mask, which its `self` is. One
// letter, as `head t` is: a longer name is spelled two ways natively (Kotlin's `WEARER` parameter, `Wearer` where it
// is used), and a default that writes `head w` of its own shadows it
export const MASK_SELF = 'w'

// the arms a `fork test` reads, by the word after `hook` (`conditionOf`)
const FORK_TEST_ARMS = new Set(['test', 'hold', 'step', 'miss', 'else', 'fall'])

// `walk list, <seq>` iterates; `walk test` loops while a condition holds. Both arrive as one `walk` form
// distinguished by its mode word, which is the only thing that tells them apart.
// a contract's lines: every `must <claim>` (an invariant on a walk, a postcondition on a task), every `have <claim>`
// (a task's precondition), and the one `down <measure>`. Read only by the checker. See check/contract.ts.
function contractOf(
  bridge: Bridge,
  value: Form,
): { have?: Expression[]; must?: Expression[]; down?: Expression } {
  const linesAt = (site: string): Expression[] =>
    formsAt(value, site)
      .map(line => expressionOf(bridge, firstAt(line, 'seed')))
      .filter((e): e is Expression => e !== undefined)

  const have = linesAt('have')
  const must = linesAt('must')
  const down = linesAt('down')[0]

  return {
    ...(have.length > 0 ? { have } : {}),
    ...(must.length > 0 ? { must } : {}),
    ...(down ? { down } : {}),
  }
}

function loopOf(
  bridge: Bridge,
  value: Form,
): Statement | Statement[] | undefined {
  const span = spanOf(value)
  const written = wordAt(value, 'mode')
  const hooks = formsAt(value, 'hook')

  for (const hook of hooks) {
    refuseNestedTasks(bridge, hook)
  }

  const { must, down } = contractOf(bridge, value)
  // `walk ..., name outer`: the loop's name, for a `turn next` or `halt` in a nested loop to mean this one
  const label = wordAt(value, 'name')
  const contract = {
    ...(must ? { must } : {}),
    ...(down ? { down } : {}),
    ...(label ? { label } : {}),
  }

  // The mode is a closed set, so anything outside it is the SEQUENCE: `walk one/stem` is `walk list, ...`.
  // An unrecognized mode used to fall through to a loop that never runs, silently. lean-0023.
  const mode = WALK_MODES.has(written ?? '') ? written : 'list'
  // a bare `walk items` names a variable, which is what the value fallback would have built anyway
  const named: Expression | undefined =
    written !== undefined && !WALK_MODES.has(written)
      ? written.includes('{')
        ? readPath(plainName(written), span)
        : { form: 'variable', name: plainName(written), span }
      : undefined

  if (mode === 'list') {
    const iterable = expressionOf(bridge, firstAt(value, 'seed')) ?? named
    // `hook next` is the long form; the `take` and `flow` sites carry the short one
    const next = hooks.find(h => wordAt(h, 'name') === 'next') ?? hooks[0]
    // the takes, in written order: the first names the item and a SECOND names the turn's INDEX. A walk had
    // no way to name its own position before, and the answer was a `save` counter beside the loop. lean-0017
    // With a `hook next`, ITS take is the item (that is the established spelling) and a take on the walk
    // itself is the index. Written short, the walk's own takes are item then index, in order.
    const takes = next
      ? [...formsAt(next, 'take'), ...formsAt(value, 'take')]
      : formsAt(value, 'take')
    const binder = takes[0]
    const counter = takes[1]

    // `take site, name item` names it in its alias; written directly under the walk, `take one` names itself
    const item =
      wordAt(firstAt(binder, 'alias'), 'name') ??
      textOf(firstAt(binder, 'alias')) ??
      wordAt(binder, 'name') ??
      ''

    const index = counter
      ? (wordAt(firstAt(counter, 'alias'), 'name') ??
        textOf(firstAt(counter, 'alias')) ??
        wordAt(counter, 'name'))
      : undefined
    const turnBinds = index ? [item, index] : [item]
    const body = next
      ? scopedFlow(bridge, at(next, 'flow'), turnBinds)
      : scopedFlow(bridge, at(value, 'flow'), turnBinds)

    if (!iterable) {
      return unhandled(bridge, value, 'a walk with no sequence')
    }

    if (!next && body.length === 0) {
      return unhandled(bridge, value, 'a walk with no body')
    }

    return {
      form: 'for-each',
      item,
      ...(index ? { index } : {}),
      iterable,
      body,
      ...(must ? { must } : {}),
      ...(label ? { label } : {}),
      span,
    }
  }

  if (mode === 'test') {
    const test = hooks.find(h => wordAt(h, 'name') === 'test')
    const hooked = hooks.filter(h => {
      const name = wordAt(h, 'name')

      return name === 'step' || name === 'hold'
    })

    // A BARE `hold` (or `step`) is the body, as `hold` is under a `fork`. The walk rule has no arm site for one,
    // so it landed in the walk's sequence or statement site, which a `walk test` never reads: `walk test / hook
    // test, true / hold / halt` compiled to `while (true) {}` and a contract over the loop "proved" with the body
    // gone (2026-10-02, test/compile/silent-defects.ts). Read off the parse tree, every line under it through the
    // grammar's own statement rule. ANY OTHER line directly under the walk is refused: it is in no part of the
    // loop, and it used to be dropped the same way.
    const bare: GroupNode[] = []

    if (value.node?.kind === 'group') {
      for (const child of value.node.nodes.slice(2)) {
        if (child.kind !== 'group') {
          continue
        }

        const head = headWord(child)

        if (head === 'hold' || head === 'step') {
          bare.push(child)
        } else if (!WALK_TEST_PARTS.has(head ?? '')) {
          refuse(
            bridge,
            { kind: 'word', value: head ?? '', node: child },
            `this line is directly under a \`walk test\`, which reads only \`hook test\`, its body under \`hold\`, and \`must\` / \`down\`. Put it in the body, under \`hold\``,
          )
        }
      }
    }

    const bodyCount = hooked.length + bare.length
    const step = hooked[0]
    const bareBody = step ? undefined : bare[0]

    // `walk test` with no `hook test` has no condition, and the mill writes `false`, so the loop never runs. That
    // used to compile in silence: `hash-djb2-xor` wrote its condition as `hook step` and its body as `hook hold`,
    // compiled to `while (false)`, and hashed every text to 5381 for as long as it existed. Refused now, and so is a
    // walk with two bodies, since only one of them would run
    if (!test) {
      bridge.diagnostics.push(
        diagnose('unexpected-node', {
          file: bridge.file,
          span: spanOf(value),
          message:
            'this `walk test` has no `hook test`, so it has no condition and would never run. Write the condition under `hook test` and the body under `hook hold`',
        }),
      )
    }

    if (bodyCount > 1) {
      bridge.diagnostics.push(
        diagnose('unexpected-node', {
          file: bridge.file,
          span: spanOf(value),
          message:
            'this `walk test` has two bodies (`hook step`, `hook hold` or `hold`), and only the first would run. Keep one',
        }),
      )
    }

    const cond = expressionOf(bridge, firstAt(test, 'flow')) ?? {
      form: 'boolean' as const,
      value: false,
      span,
    }

    return {
      form: 'while',
      cond,
      body: step
        ? scopedFlow(bridge, at(step, 'flow'))
        : bareBody
          ? scopedFlow(bridge, flowFromNodes(bridge, bareBody.nodes.slice(1)))
          : [],
      ...contract,
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
    // `bind step` counts by that much, and a negative step counts DOWN, from `base` to above `head` (guides:
    // language/loops, 2026-10-04). A literal step decides the comparison here; zero never ends, so it is refused
    const by = boundOf('step') ?? { form: 'integer', value: 1, span }
    const literal = by.form === 'integer' ? Number(by.value) : by.form === 'unary' && by.op === '-' && by.operand.form === 'integer' ? -Number(by.operand.value) : undefined

    if (literal === 0) {
      return refuse(bridge, value, 'a `walk size` with `step 0` never ends: count by a step other than zero')
    }
    const next = hooks.find(h => wordAt(h, 'name') === 'next') ?? hooks[0]
    // the counter is named by a `take` inside `hook next`, or by one beside the `bind` lines, which used to be dropped
    // and leave the counter `i` while the body read a name nothing bound
    const binder = formsAt(next, 'take')[0] ?? formsAt(value, 'take')[0]
    const item =
      wordAt(firstAt(binder, 'alias'), 'name') ??
      textOf(firstAt(binder, 'alias')) ??
      wordAt(binder, 'name') ??
      'i'

    if (!to || !next) {
      return unhandled(bridge, value, 'a walk size with no bound')
    }

    // this walk's place among the file's walks, which names its temporaries (Bridge, `walks`)
    const ordinal = bridge.walks.count++

    // A counter whose name is already a local here (the walk around this one, or a `save` of that name) gets a name of
    // its own, unique by the walk's ordinal, and the body's references are rewritten to it. The loop's `let` lands in the scope
    // the walk is written in, so a second `let i` there was the same variable as the first: two nested `walk size`
    // loops shared one counter, the outer step moved the inner one, and the outer loop never ended (guides:
    // language/loops, 2026-10-03). The body still reads it as `i`, which shadows the outer `i` as it should
    const name = inScope(bridge, item) ? `${item}-walk-${ordinal}` : item
    const counter: Expression = { form: 'variable', name, span }

    // the head is read ONCE, before the first turn, as a counted loop means. Written into the condition it was called
    // again every turn: `char-count` rebuilt the text's character array per character, and the prover could not read
    // a measure off a native call it has to treat as different each time. A name or a literal is left in place. The
    // name is unique by the walk's ordinal, so two walks in one scope never declare it twice
    const steady = to.form === 'variable' || to.form === 'integer'
    const headName = `walk-head-${ordinal}`
    const bound: Expression = steady ? to : { form: 'variable', name: headName, span }

    // a step that is not a literal is read once too, and the condition follows its sign
    const stepName = `walk-step-${ordinal}`
    const stepping: Expression = literal !== undefined || by.form === 'variable' ? by : { form: 'variable', name: stepName, span }
    const zero: Expression = { form: 'integer', value: 0, span }
    const below: Expression = { form: 'binary', op: '<', left: counter, right: bound, span }
    const above: Expression = { form: 'binary', op: '>', left: counter, right: bound, span }
    const cond: Expression =
      literal === undefined
        ? {
            form: 'binary',
            op: '||',
            left: { form: 'binary', op: '&&', left: { form: 'binary', op: '>', left: stepping, right: zero, span }, right: below, span },
            right: { form: 'binary', op: '&&', left: { form: 'binary', op: '<', left: stepping, right: zero, span }, right: above, span },
            span,
          }
        : literal > 0
          ? below
          : above

    const flow = scopedFlow(bridge, at(next, 'flow'), [item])
    const advance: Statement = {
      form: 'assign',
      target: counter,
      op: '=',
      value: { form: 'binary', op: '+', left: counter, right: stepping, span },
      span,
    }

    return [
      ...(steady ? [] : [{ form: 'let', name: headName, init: to, mutable: false, span } as Statement]),
      ...(stepping === by ? [] : [{ form: 'let', name: stepName, init: by, mutable: false, span } as Statement]),
      { form: 'let', name, init: from, mutable: true, span },
      {
      form: 'while',
      cond,
      body: [...advancedBeforeContinue(name === item ? flow : renameLocal(flow, item, name), advance, label), advance],
      ...contract,
      span,
      },
    ]
  }

  // any other mode is one the mill has no lowering for: it writes a loop that never runs, which is refused rather than
  // compiled, for the same reason as a `walk test` with no condition
  return unhandled(bridge, value, `a \`walk ${mode}\``) ?? {
    form: 'while',
    cond: { form: 'boolean', value: false, span },
    body: [],
    span,
  }
}

// A counted walk is a `while` whose last statement steps the counter, and `turn next` is a `continue`, which jumps
// past that step: a walk that turned next on any turn counted the same number forever (guides: language/loops,
// 2026-10-04). Every `continue` that belongs to THIS loop steps the counter first: an unnamed one in its own body, and
// one naming this loop (`turn next, name outer`) from however deep a nested loop it sits in. An unnamed one inside a
// nested loop belongs to that loop and is left alone.
function advancedBeforeContinue(body: Statement[], advance: Statement, label?: string, nested = false): Statement[] {
  const inner = (statements: Statement[], deeper = nested): Statement[] => advancedBeforeContinue(statements, advance, label, deeper)

  return body.flatMap((statement): Statement[] => {
    switch (statement.form) {
      case 'continue':
        return (statement.label === undefined ? !nested : statement.label === label) ? [structuredClone(advance), statement] : [statement]
      case 'if':
        return [
          {
            ...statement,
            branches: statement.branches.map(b => ({ ...b, body: inner(b.body) })),
            ...(statement.otherwise ? { otherwise: inner(statement.otherwise) } : {}),
          },
        ]
      case 'match':
        return [
          {
            ...statement,
            cases: statement.cases.map(c => ({ ...c, body: inner(c.body) })),
            ...(statement.otherwise ? { otherwise: inner(statement.otherwise) } : {}),
          },
        ]
      case 'guard':
        return [
          {
            ...statement,
            body: inner(statement.body),
            ...(statement.catch ? { catch: { ...statement.catch, body: inner(statement.catch.body) } } : {}),
          },
        ]
      // a nested loop: only a `continue` naming this one is this loop's
      case 'while':
      case 'for-each':
        return label === undefined ? [statement] : [{ ...statement, body: inner(statement.body, true) }]
      default:
        return [statement]
    }
  })
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
    // a leading run of `link <name>` lines selects or renames the variant's fields
    const binds = at(arm, 'link')
      .map(link => wordAt(link, 'name') ?? textOf(link) ?? '')
      .filter(Boolean)
    const body = scopedFlow(bridge, at(arm, 'flow'), binds)

    // `hook miss` (lean: `miss`) is the arm for every case the others do not list, the catch-all. It arrives as the
    // `hook` arm form a `fork test` uses, with a kind and no case name, so any other kind is a word a match does not
    // take, and a second one is two answers for the same cases
    if (label === undefined) {
      const kind = wordAt(arm, 'kind')

      if (kind !== undefined && kind !== 'miss') {
        refuse(
          bridge,
          arm,
          `\`hook ${kind}\` is not an arm of a \`sift\`, whose arms are \`case <name>\` and one \`hook miss\` for every case they do not list`,
        )
      } else if (otherwise) {
        refuse(bridge, arm, 'this match has two `hook miss` arms, and one answers every case the others do not list')
      }

      otherwise = body
      continue
    }

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
//
// A TASK MAY BE NAMED `host` (the site framework's `host(route, port)` is one), and the statement rule matches the
// constant first. Read as a constant, `host(route, port)` declared `route` as a copy of `port` and the call was
// gone: the enclosing task compiled to an empty body with no message (2026-10-02, test/compile/silent-defects.ts).
// So three readings, in order:
//   1. `host(` with the parenthesis straight after the word is a CALL, as `f(a, b)` is everywhere else. Nothing
//      in the tree writes a constant that way.
//   2. In a body, a constant whose name is already a local cannot be a constant (it would rebind a parameter or a
//      `save`), so it is refused, naming the call spelling.
//   3. In a body, in a file that defines or imports a task named `host`, the stacked or comma spelling reads both
//      ways, so it is refused, naming both spellings.
function constantOf(bridge: Bridge, value: Form): Statement | undefined {
  const span = spanOf(value)
  const name = wordAt(value, 'name')

  if (value.node?.kind === 'group' && opensParen(value.node.nodes[0])) {
    const call = expressionFromNode(bridge, value.node, span)

    return call
      ? { form: 'expression', expr: call, span }
      : refuse(bridge, value, '`host(...)` is a call to a task named `host`, and its arguments could not be read')
  }

  if (name === undefined) {
    return unhandled(bridge, value, 'a host with no name')
  }

  if (bridge.inBody && inScope(bridge, name)) {
    return refuse(
      bridge,
      value,
      `\`host ${name}\` declares a constant named \`${name}\`, and \`${name}\` is already bound here. To call a task named \`host\`, write \`host(${name}, ...)\` or \`call host\` over its arguments. To change \`${name}\`, write \`save ${name}\``,
    )
  }

  if (bridge.inBody && bridge.hostTask) {
    return refuse(
      bridge,
      value,
      `this file has a task named \`host\`, so \`host ${name}\` reads both as a constant and as a call. Write \`host(${name}, ...)\` or \`call host\` for the call, or \`save ${name}\` for a local`,
    )
  }

  bridge.bound.add(name)

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

  // THE DECLARED TYPE DECIDES, NOT THE COUNT. `host xs / like list / like number / 1` is a one-element list
  // and `host x / like number / 1` is a number, and until 2026-09-13 the two were the same bytes, because the
  // count alone chose between an array and its first element. That is the hazard the lean property rule
  // already refuses, and it is worse here: a one-element export and a scalar export were indistinguishable
  // with the type written on the line directly above.
  //
  // A LITERAL child only. `host xs / like list / read ys` and `host xs / like list / call more-states` both
  // hand the binding a value that may ITSELF be the list, and the mill has no callee and no scope to tell
  // which, so those keep the old reading and are left to the checker, exactly as a lean list PARAMETER with
  // one child is. What is decidable right here is that a text, a number, a boolean or a record is never a
  // list, so a single one of them under a `like list` is a one-element list and nothing else.
  const onlyChild = values.length === 1 ? values[0]! : undefined
  const oneLiteral =
    onlyChild !== undefined &&
    (onlyChild.form === 'string' ||
      onlyChild.form === 'integer' ||
      onlyChild.form === 'float' ||
      onlyChild.form === 'boolean' ||
      onlyChild.form === 'record')
  const listed = type?.kind === 'array' && oneLiteral

  const init =
    nested.length > 0
      ? anonymousRecord(bridge, nested, span)
      : listed || values.length > 1
        ? ({ form: 'array', items: values, span } as Expression)
        : (values[0] ?? { form: 'unit' as const, span })

  // With no `like`, the constant's type is the one its LITERAL names: an integer literal is `integer`, a
  // decimal literal `float` (the type word `decimal` is refused since D4), a text `text`, a boolean `boolean`. Anything else is left to inference. A decimal was named
  // `number`, from when that was the float's name: `number` is the integer now, so `host limit, 5.0` was declared an
  // integer, and Swift, which spells a binding's declared type, refused `let limit: Int = 5.0` (time/compare's
  // `significant-percent`, 2026-10-04). TypeScript writes `number` for both and never showed it
  const literalType: Type | undefined =
    init.form === 'integer'
      ? { kind: 'named', name: 'integer' }
      : init.form === 'float'
        ? { kind: 'named', name: 'float' }
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

  // A `hook <word>` the fork has no arm for never reaches the arm list: the grammar matches it so the file still reads,
  // and it was dropped. `hook true` under `fork test` compiled to `if (n < 0) {}`, its body gone (guides:
  // language/branching, 2026-10-03). Read off the parse tree, as `walk test` does for its stray lines
  if (value.node?.kind === 'group') {
    for (const child of value.node.nodes.slice(2)) {
      if (child.kind !== 'group' || headWord(child) !== 'hook') {
        continue
      }

      const second = child.nodes[1]
      // every word after a head parses as a group of its own, so the arm's word is that group's head
      const word = second?.kind === 'group' ? headWord(second) : undefined

      if (word !== undefined && !FORK_TEST_ARMS.has(word)) {
        refuse(
          bridge,
          { kind: 'word', value: word, node: child },
          `\`hook ${word}\` is not an arm of a \`fork test\`, which has \`hook test\` (a condition), \`hook hold\` (what runs when it holds) and \`hook miss\` (what runs otherwise)`,
        )
      }
    }
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
  span: Span
} {
  const name = wordAt(take, 'name') ?? ''
  const declared = withHeadArgs(
    bridge,
    withOuterTakes(bridge, typeOf(bridge, firstAt(take, 'like')), take),
    take,
  )
  refuseSiblingLikes(bridge, take, declared)
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
  // `like u8` and the other width aliases are a `number`; the width is kept so a literal outside it is refused
  const word = like ? (textOf(like) ?? wordAt(like, 'name')) : undefined
  const width = word !== undefined && WIDTH_WORDS.has(word) ? word : undefined

  return {
    name,
    ...(type ? { type } : {}),
    ...(refine ? { refine: 'natural' as const } : {}),
    ...(width ? { width } : {}),
    ...(optional ? { optional: true } : {}),
    ...(fallback ? { fallback } : {}),
    span: spanOf(take),
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
  // `like u8` on the result, kept as a parameter's width is: a call to the task is a value inside it
  // (check/width-range.ts)
  const resultLike = firstAt(value, 'like')
  const resultWord = resultLike ? (textOf(resultLike) ?? wordAt(resultLike, 'name')) : undefined
  const resultWidth = resultWord !== undefined && WIDTH_WORDS.has(resultWord) ? resultWord : undefined
  // a function body is its own scope: a `save` inside it declares, whatever the enclosing body has bound
  const enclosing = bridge.declared
  const outer = bridge.bound
  const enclosingBody = bridge.inBody
  bridge.declared = new Set(params.map(p => p.name))
  bridge.bound = new Set()
  bridge.inBody = true
  // `task read-synchronously, name <read-file>` annotates the task with the host name it maps to. The comma
  // leaves it where a body statement would sit, and it is not one: the mill emits an empty body here.
  const written = bodySteps(bridge, value).filter(
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
      isHaltWord(mode) ||
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
  // the contract is read with the parameters in scope, which is where its claims are stated
  const contract = contractOf(bridge, value)
  bridge.declared = enclosing
  bridge.bound = outer
  bridge.inBody = enclosingBody

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

  refuseNestedTasks(bridge, value)

  // every `mark` word on a task is one something reads. A word outside the list was accepted and read by nothing, so a
  // misspelled `mark deprecatd` meant nothing and said so nowhere (guides: language/notes, 2026-10-03). The metadata
  // words the mill mints as a `note` (note/mine.tree `mark-note`) arrive under `note`, as a word: a text literal there
  // is documentation (`note <A sentence.>`)
  const marks = [
    ...formsAt(value, 'mark').map(mark => ({ at: mark, kind: wordAt(mark, 'kind') })),
    ...at(value, 'note').map(note => {
      const word = firstAt(note, 'text')

      return { at: note, kind: word?.kind === 'word' ? word.value : undefined }
    }),
  ]

  for (const mark of marks) {
    if (mark.kind !== undefined && !TASK_MARKS.has(mark.kind)) {
      bridge.diagnostics.push(
        diagnose('unexpected-node', {
          file: bridge.file,
          span: spanOf(mark.at),
          message: FILE_MARKS.has(mark.kind)
            ? `\`mark ${mark.kind}\` marks a file, not a task: write it unindented at the top level of the file`
            : `\`mark ${mark.kind}\` is not a mark a task takes. The marks are ${[...TASK_MARKS].join(', ')}`,
        }),
      )
    }
  }

  return {
    form: 'function',
    name,
    params,
    body,
    // `mark deprecated`: a call to it from another file warns (check/deprecated.ts)
    ...(marked(value, 'deprecated') ? { deprecated: true } : {}),
    ...(result ? { result } : {}),
    ...(resultWidth ? { resultWidth } : {}),
    generics,
    // the bound on what this task may raise, from the leading `halt <form>` lines
    ...(raises.length > 0 ? { raises } : {}),
    // `have` / `must` / `down`: the task's contract, which only the checker reads
    ...contract,
    // `wait true` on a DEFINITION marks it async, the same as `note async`. The two are not alternatives in
    // the reader, they are two spellings of one fact, and a task that says only `wait true` is async too.
    ...(marked(value, 'async') || waitsTrue(value) ? { async: true } : {}),
    // `mark private`: visible only inside this file, enforced by check/private.ts. `note private` is the old
    // spelling, still honored, and its line is kept so the checker can warn about it
    ...(marked(value, 'private') ? { private: true } : {}),
    ...privateNoteOf(value),
    // `note roam`: meant to run forever (a server, an event loop)
    ...(marked(value, 'roam') ? { roam: true } : {}),
    ...(owner ? { method: { form: owner, name: bare } } : {}),
    span: spanOf(value),
  }
}

// `twin <task>, name <label>`: another implementation of a named task (note/term/optimize/words.md). Read into a
// `Twin` beside the program, never into it, so nothing that does not choose between implementations ever sees one.
function twinOf(bridge: Bridge, value: Form): Twin | undefined {
  const of = wordAt(value, 'name')
  const name = wordAt(firstAt(value, 'label'), 'name')

  if (of === undefined || name === undefined) {
    refuse(bridge, value, 'a twin names the task it twins and its own label: `twin <task>, name <label>`')

    return undefined
  }

  const takes = formsAt(value, 'take')

  // a twin's parameters take their types from the task it twins, so a type written on one is refused: a twin is
  // read beside its reference, and two places for one type can disagree
  for (const take of takes) {
    if (firstAt(take, 'like')) {
      refuse(bridge, take, `a twin's parameters take their types from \`${of}\`: write \`take ${wordAt(take, 'name') ?? 'x'}\` alone`)
    }
  }

  const params = takes.map(take => wordAt(take, 'name') ?? '').filter(Boolean)
  const knobs = formsAt(value, 'knob').map(knob => {
    const type = typeOf(bridge, firstAt(knob, 'like'))

    return { name: wordAt(knob, 'name') ?? '', ...(type ? { type } : {}) }
  })
  const lines = (site: string): Expression[] =>
    formsAt(value, site)
      .map(line => expressionOf(bridge, firstAt(line, 'seed')))
      .filter((e): e is Expression => e !== undefined)

  // metadata is a `mark` (a `note` is documentation and nothing else): `mark platform, name rust`, `mark trust`
  const marks = formsAt(value, 'mark').map(mark => ({
    kind: wordAt(mark, 'kind'),
    name: wordAt(firstAt(mark, 'name'), 'name'),
  }))
  const platform = marks
    .filter(mark => mark.kind === 'platform' && mark.name !== undefined)
    .map(mark => mark.name!)

  // the body is its own scope, with the parameters and the knobs bound
  const enclosing = bridge.declared
  bridge.declared = new Set([...params, ...knobs.map(k => k.name)])
  const body = flowOf(bridge, at(value, 'flow'))
  bridge.declared = enclosing

  const cost = lines('cost')[0]

  return {
    of,
    name,
    params,
    have: lines('have'),
    test: lines('test'),
    ease: formsAt(value, 'ease').map(ease => wordAt(ease, 'name') ?? '').filter(Boolean),
    ...(cost ? { cost } : {}),
    knobs,
    platform,
    trust: marks.some(mark => mark.kind === 'trust'),
    body,
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

      // `base <dir>` forces the package root, and must name the path's first segment. The loader resolves with it
      // (and finds nothing when it disagrees); this is where the disagreement is SAID, at the load, naming both
      {
        const base = wordAt(firstAt(value, 'base'), 'value')
        const path = wordAt(value, 'path')
        const refused = base !== undefined && path !== undefined ? baseRefusal(path, base) : undefined

        if (refused) {
          refuse(bridge, firstAt(value, 'base') ?? value, refused)
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

    // another implementation of a named task: returned beside the program, so it adds no statement
    case 'twin': {
      const twin = twinOf(bridge, value)

      if (twin) {
        bridge.twins.push(twin)
      }

      return []
    }

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

      const declared = formsAt(value, 'task').filter(task => wordAt(task, 'name') !== undefined)
      const out: Statement[] = []

      // a task with a body is a DEFAULT: one generic task over every form wearing the mask, `<mask>_<task>`, its
      // `self` that form. A form that wears the mask and leaves the task out is given it by check/mask-defaults.ts,
      // which calls this. Until 2026-10-05 the body was dropped and a call failed as not defined
      const defaults = new Set<string>()
      const outer = bridge.owner
      const outerSelf = bridge.selfType
      const outerParams = bridge.ownerParams
      bridge.owner = name
      bridge.selfType = { kind: 'named', name: MASK_SELF, args: [] }
      bridge.ownerParams = [MASK_SELF]

      for (const task of declared) {
        if (bodySteps(bridge, task).length === 0) {
          continue
        }

        const built = functionOf(bridge, task)

        if (built?.form === 'function') {
          const { method: _method, ...plain } = built
          defaults.add(wordAt(task, 'name')!)
          out.push({ ...plain, generics: plain.generics.map(g => (g.name === MASK_SELF ? { ...g, need: name } : g)) })
        }
      }

      bridge.owner = outer
      bridge.selfType = outerSelf
      bridge.ownerParams = outerParams

      return [
        {
          form: 'mask',
          name,
          methods: declared.map(task => wordAt(task, 'name')!),
          // each task's signature as written, so a call through a type that needs the mask is typed by it
          tasks: declared.map(task => {
            const result = typeOf(bridge, firstAt(task, 'like'))

            return {
              name: wordAt(task, 'name')!,
              signature: {
                params: formsAt(task, 'take').map(take => {
                  const type = typeOf(bridge, firstAt(take, 'like'))

                  return type ? { type } : {}
                }),
                ...(result ? { result } : {}),
              },
              default: defaults.has(wordAt(task, 'name')!),
            }
          }),
          span: spanOf(value),
        },
        ...out,
      ]
    }

    case 'suit': {
      // `suit <target>` declares nothing itself: its `wear` blocks are trait implementations for the target
      const target = wordAt(value, 'name')

      if (target === undefined) {
        return []
      }

      // and its bodies, lifted as functions over the target exactly as a `wear` under the form lifts them. Until
      // 2026-10-05 only the instance was kept, so it named methods nothing defined: `"measure" is not defined`
      const outer = bridge.owner
      const outerSelf = bridge.selfType
      const outerParams = bridge.ownerParams
      bridge.owner = target
      bridge.selfType = { kind: 'named', name: target, args: [] }
      bridge.ownerParams = []

      const out: Statement[] = []

      for (const worn of formsAt(value, 'wear')) {
        const mask = wordAt(worn, 'name')

        if (mask === undefined) {
          continue
        }

        out.push({
          form: 'instance' as const,
          mask,
          target,
          methods: formsAt(worn, 'task')
            .map(task => wordAt(task, 'name') ?? '')
            .filter(Boolean),
          span: spanOf(worn),
        })

        for (const task of formsAt(worn, 'task')) {
          const built = functionOf(bridge, task)

          if (built) {
            out.push(built)
          }
        }
      }

      bridge.owner = outer
      bridge.selfType = outerSelf
      bridge.ownerParams = outerParams

      return out
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
// accepted alongside it because it is live in several fixtures (`mark async`). Refusing it was tried and
// reverted. PRIVACY IS THE EXCEPTION: `mark private` is its canonical spelling since 2026-10-02, enforced per
// file (check/private.ts), and `note private` is the old one, honored and warned about (privateNoteOf below).
function marked(value: Form, word: string): boolean {
  return (
    hasWord(value, 'note', word) ||
    formsAt(value, 'mark').some(mark => wordAt(mark, 'kind') === word)
  )
}

// The line of a `note private` on a task that does not also say `mark private`: the old spelling, which the
// checker warns about (`note-private`) while still honoring it.
function privateNoteOf(value: Form): { privateNote?: Span } {
  if (formsAt(value, 'mark').some(mark => wordAt(mark, 'kind') === 'private')) {
    return {}
  }

  const note = at(value, 'note').find(
    v => textOf(v) === 'private' || wordAt(v, 'text') === 'private',
  )

  return note ? { privateNote: spanOf(note) } : {}
}

// `wait true` written on the definition itself. `wait false` is fire-and-forget and is not this: the marker's
// value is a `seed`, and only the boolean true means await.
function waitsTrue(value: Form): boolean {
  return formsAt(value, 'wait').some(
    wait => wordAt(wait, 'seed') === 'true',
  )
}

// A task's or a closure's statements in written order, with every `wait <call>` line among them.
//
// The `task` rule matches `wait` at its OWN site, for the `wait true` marker on a definition, and that site takes
// any value. So `wait append(target, line)` written as a statement in a body landed there instead of in the flow,
// was read as a marker that is not `true`, and the call vanished from the output with no message (2026-10-02,
// test/compile/silent-defects.ts). A `wait` whose value is not the literal `true` or `false` is an awaited
// statement, and it goes back where it was written: each one's position among the task's own children is the
// order, the way `callOf` orders a call's arguments.
function bodySteps(bridge: Bridge, value: Form): Minted[] {
  const flow = at(value, 'flow')
  const awaited = formsAt(value, 'wait').filter(wait => {
    const word = wordAt(wait, 'seed')

    return word !== 'true' && word !== 'false'
  })
  // A line the grammar matched as the binding dialect's vocabulary (code/drop/mine.tree) whose head the file defines
  // or imports is a call, read again as one. `home host` placing a component called `home` was dropped in silence,
  // and the page served an empty `<div></div>` (guides: applications/web, commands/cast, 2026-10-04). In
  // `@term/bind`, `home true` and `rank value` name nothing the file defines, and stay dropped
  const called = at(value, 'drop').flatMap(drop =>
    drop.node?.kind === 'group' && bridge.named.has(headWord(drop.node) ?? '')
      ? flowFromNodes(bridge, [drop.node]).map(step => ({ ...step, node: drop.node }))
      : [],
  )

  if (awaited.length === 0 && called.length === 0) {
    return flow
  }

  const steps = [...flow, ...awaited, ...called]

  const order = new Map<Node, number>()

  if (value.node?.kind === 'group') {
    value.node.nodes.forEach((child, index) => order.set(child, index))
  }

  return steps
    .map((step, index) => ({
      step,
      at: step.node ? (order.get(step.node) ?? index) : index,
    }))
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.step)
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

  // a text with braces in it is a dynamic text node, its value the template, as it is anywhere else a text is read.
  // It was its literal chunks alone: `view p, <Nothing at {path}>` served `<p>Nothing at </p>`, with no message
  // (guides: applications/web/routes, 2026-10-04)
  const textNode = (literal: Minted, fallback: string): ViewNode => {
    const built = textExpression(bridge, literal, span)

    return built.form === 'template' ? { form: 'read', value: built, span } : { form: 'text', value: fallback, span }
  }

  // a bare text literal sitting in a body, rather than `text <...>`
  if (value.kind === 'text') {
    return textNode(value, value.value)
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
    const literal = firstAt(text, 'value')

    return literal ? textNode(literal, wordAt(text, 'value') ?? '') : { form: 'text', value: wordAt(text, 'value') ?? '', span }
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
    // an attribute whose value is a CALL, or a whole statement body, is an event handler. A call in EITHER
    // spelling: `call f` and the bare `f(a, b)` (or `f` over its arguments, or `f()`) are one call, and until
    // 2026-10-02 only the first was a handler, so the bare one bound the call's RESULT as an attribute with no
    // message (`bindAttribute(view, "click", ...)`, test/compile/silent-defects.ts). A builtin folds to an
    // operator in both spellings and stays a value in the bare one, since `add(a, b)` is arithmetic, not a call.
    const first = at(attribute, 'seed')[0]
    const bareCall =
      (first?.kind === 'form' &&
        (first.form === 'seed-call-open' || first.form === 'seed-wait') &&
        (built?.form === 'call' ||
          (built?.form === 'await' && built.expr.form === 'call'))) ||
      (first?.kind === 'word' && built?.form === 'call')
    const event =
      multi || (first?.kind === 'form' && first.form === 'call') || bareCall

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

// `mark a, like t` under a `rule` or its `have` was the theorem's variable until 2026-10-05, when it became `seat`:
// `mark` means metadata, an identity and a version, and one word with four meanings told apart by whether a `like`
// follows was the problem. Refused by name rather than read, so a file that still says it fails at the line instead
// of quietly losing a variable. `pnpm term:seat-migrate --commit` rewrites a tree.
function refuseMarkBinders(bridge: Bridge, value: Form): void {
  for (const mark of formsAt(value, 'mark')) {
    const name = wordAt(mark, 'name') ?? 'x'

    bridge.diagnostics.push(
      diagnose('unexpected-node', {
        file: bridge.file,
        span: spanOf(mark),
        message: `\`mark ${name}\` is the old spelling of a theorem's variable. A variable of a rule is a \`seat\``,
        hint: `write \`seat ${name}\` in its place, or run \`pnpm term:seat-migrate --commit\` over the tree`,
      }),
    )
  }
}

// A `rule` is a named THEOREM or AXIOM, and it desugars to a FUNCTION: its universal `seat` binders become the
// parameters, so the goal is checked as a law over them by the same prover stack a `hold` uses. A theorem's body
// is the goal held under its hypotheses; an axiom's is the hypotheses and the claim bound as values, postulated
// rather than proved. See note/term/law-and-proof.md.
//
// TWO SHAPES, told apart by one thing: whether the rule states a `show` goal.
//
//   GOAL shape       `rule r / seat a / show <claim>`            a theorem over its binders. `take` is a
//                    HYPOTHESIS, and the goal becomes a `hold` the prover must discharge.
//   SIGNATURE shape  `rule r / head a / take x, like a / like a` a CLAIM: a name declared at a type, owing a
//                    proof. `take` is a PARAMETER and `like` is the result. All six rules in the tree are
//                    written this way, and the grammar already captures `head`, `take` and `like` for it.
//
// A claim is emitted as a signature-only function marked `claim`, so the name type-checks wherever it is
// mentioned while owing a body. `check/claim.ts` then requires a `task` of the same name to fill it and refuses
// live code that calls one nobody filled. `note open` keeps a claim deliberately open: counted and reported
// rather than fatal, which is what `?TODO` is for in Bend.
//
// Until 2026-09-18 a signature-shaped rule fell through to the theorem path, found no goal, and emitted a
// function whose body was `return <first param>`. It owed nothing, so a `rule` was a comment with a type on it
// and its paired `test` was connected to it by nothing but a shared spelling. See
// note/term/project/law-proof-gate.md.
function ruleOf(bridge: Bridge, value: Form): Statement[] {
  const span = spanOf(value)
  const named = firstAt(value, 'name')
  const name =
    (named?.kind === 'text' ? slugOf(named.value) : textOf(named)) ?? 'rule'

  if (formsAt(value, 'show').length === 0) {
    const claimed: Statement = {
      form: 'function',
      name,
      params: formsAt(value, 'take').map(take =>
        paramOf(bridge, take, bridge.owner),
      ),
      body: [],
      generics: formsAt(value, 'head').map(head => ({
        name: wordAt(head, 'name') ?? '',
      })),
      claim: true,
      // a claim declares and does not define: nothing elaborates or emits its empty body, the same way nothing
      // does for a separate-compilation stub
      stub: true,
      ...(marked(value, 'open') ? { open: true } : {}),
      span,
    }

    const claimResult = typeOf(bridge, firstAt(value, 'like'))

    if (claimResult) {
      claimed.result = claimResult
    }

    return [claimed]
  }

  refuseMarkBinders(bridge, value)

  // `seat x, like natural-number` carries the n >= 0 bound the prover needs, and the refinement is read from
  // the type's NAME: `typeOf` maps it to the plain number type and the name is gone by then.
  const params = formsAt(value, 'seat').map(seat => {
    const like = firstAt(seat, 'like')
    // `seat s, like stack / head nat` quantifies over a stack OF NATS, and the argument is a sibling of the
    // `like`, the same way a task parameter's is
    const type = withHeadArgs(bridge, typeOf(bridge, like), seat)
    const written = wordAt(like, 'name')

    return {
      name: wordAt(seat, 'name') ?? '',
      ...(type ? { type } : {}),
      ...(written === 'natural-number' ? { refine: 'natural' as const } : {}),
    }
  })

  const hypotheses = formsAt(value, 'have').map((have, at) => {
    refuseMarkBinders(bridge, have)

    return {
      name: wordAt(have, 'name') ?? `claim_${at}`,
      expr: expressionOf(bridge, firstAt(have, 'seed')),
      // `seat` inside a `have`: the hypothesis holds FOR EVERY value of these, so it is not a guard on the values in
      // hand but a statement the prover instantiates (check/holds.ts universalFacts)
      binders: formsAt(have, 'seat').map(seat => wordAt(seat, 'name') ?? ''),
      // and each one's type, read the way a theorem's own `seat` is, so the kernel instantiates it only at terms of it
      types: formsAt(have, 'seat').map(seat => {
        const type = withHeadArgs(bridge, typeOf(bridge, firstAt(seat, 'like')), seat)

        return type ? { type } : {}
      }),
    }
  })

  const universals = hypotheses
    .filter(h => h.binders.length > 0 && h.expr)
    .map(h => ({ name: h.name, binders: h.binders, expr: h.expr as Expression, types: h.types }))

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
        const cond = hypotheses[at]?.binders.length ? undefined : hypotheses[at]?.expr

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

  // an axiom is postulated, not proven: the trust ledger (`term hold`) lists every one by name
  return [
    {
      form: 'function',
      name,
      params,
      body,
      // `head a` on a theorem: a law about every type `a`, as on a claim (`rule union-commutes / head a / seat s, like
      // set a`). It was dropped, so the first seat naming `a` was refused as an unknown type
      generics: formsAt(value, 'head').map(head => ({
        name: wordAt(head, 'name') ?? '',
      })),
      ...(goal && axiom ? { axiom: true } : {}),
      ...(goal && !axiom ? { theorem: true } : {}),
      ...(universals.length > 0 ? { universals } : {}),
      span,
    },
  ]
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

    if (at(take, 'many').length > 0) {
      refuse(
        bridge,
        take,
        `\`many\` is retired: a take collects every word left when its type is a list. Write \`take ${wordAt(take, 'name') ?? 'x'}, like list, like text\``,
      )
    }
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
    const fallback: DockLiteral | undefined =
      literal?.form === 'integer' || literal?.form === 'float'
        ? { form: 'number', value: Number(literal.value) }
        : literal?.form === 'string'
          ? { form: 'text', value: literal.value }
          : literal?.form === 'boolean'
            ? { form: 'flag', value: literal.value }
            : undefined

    return {
      name: wordAt(take, 'name') ?? '',
      ...(type ? { type } : {}),
      required: needWord(take) === 'true',
      ...(short !== undefined ? { short } : {}),
      ...(masked ? { masked: true } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      // A LIST TAKE IS THE REST OF THE WORDS. `take paths, like list, like text` collects every positional left,
      // because a list is what it is handed: the type says it, so no second word has to. It was `take paths / many`
      // beside a `like text` until 2026-10-05, a marker that said the same thing as the type and could disagree
      // with it (a `many` on a `like text` handed a list to a task that declared text)
      ...(isListType(type) ? { variadic: true } : {}),
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
    // `page` says the same as a flag a reader can test without asking whether a key exists, which is what check/routes
    // asked, and which a Term port cannot (check/routes.tree)
    ...(isRoute ? { component, page: true } : {}),
    // a route's `seed <name>, <value>` lines are its directives: `title`, `layout`, `proxy`, a meta tag. They arrive
    // in the flow, and were dropped here until 2026-10-03, so `seed title` set no title in any build on this path while
    // the legacy mill read it (native-navigation-0002)
    // The line is an open call whose head is `seed`: its first argument names the directive (a bare word, built as a
    // variable) and its second is the value, the shape the legacy mill reads as rest[0] and rest[1]
    directives: isRoute
      ? at(value, 'flow')
          .filter(isForm)
          .filter(step => step.form === 'seed-call-open' && wordAt(step, 'name') === 'seed')
          .flatMap(step => {
            const [named, given] = at(step, 'seed').map(seed => expressionOf(bridge, seed))

            if (named?.form !== 'variable') {
              return []
            }

            return given ? [{ name: named.name, value: given }] : [{ name: named.name }]
          })
      : [],
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

  // `mark native` under a `dock load` was read by nothing: `dock` is what says a module is native, so the mark
  // repeated it, and any other word there meant nothing at all (guides: language/notes, 2026-10-04)
  for (const note of at(value, 'note')) {
    bridge.diagnostics.push(
      diagnose('unexpected-node', {
        file: bridge.file,
        span: spanOf(note),
        message: `\`mark ${textOf(note) ?? wordAt(note, 'text') ?? ''}\` under \`dock ${kind ?? 'load'}\` is read by nothing: \`dock\` already says the module is native. Remove the line`,
      }),
    )
  }

  return formsAt(value, 'line').flatMap(line => {
    const module = wordAt(line, 'path')
    const alias = wordAt(line, 'name')

    // a line with no alias binds nothing and is skipped, the way the mill skips it
    if (module === undefined || alias === undefined) {
      return []
    }

    // `mark async` under the line is the one word read there: the module's functions return promises
    let async = false

    for (const note of at(line, 'note')) {
      const word = textOf(note) ?? wordAt(note, 'text') ?? ''

      if (word === 'async' && kind !== 'type') {
        async = true
        continue
      }

      bridge.diagnostics.push(
        diagnose('unexpected-node', {
          file: bridge.file,
          span: spanOf(note),
          message: kind === 'type'
            ? `\`mark ${word}\` under a \`dock type\` line is read by nothing: a handle type is not called. Remove the line`
            : `\`mark ${word}\` under a \`dock load\` line is read by nothing: \`mark async\` is the one word read there. Remove the line`,
        }),
      )
    }

    return [
      {
        form: 'native' as const,
        alias,
        module,
        kind: kind === 'type' ? ('type' as const) : ('module' as const),
        ...(async ? { async: true } : {}),
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
  span: Span
} {
  const like = firstAt(link, 'like')
  const listOf = firstAt(link, 'list')
  const declared = withHeadArgs(
    bridge,
    withOuterTakes(bridge, typeOf(bridge, like), link),
    link,
  )
  refuseSiblingLikes(bridge, link, declared)
  const element = wordAt(listOf, 'form')
  const type: Type =
    declared ??
    (element !== undefined
      ? { kind: 'array', element: named(element) }
      : unknownType())
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
    span: spanOf(link),
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
  const primitive = isTypeName(name) ? typeOfWord(name) : undefined
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
    // `mark text` (D9): a closed set of texts, each case its text, `case plus, text <+>`, or its name in snake_case
    const textual = formsAt(value, 'mark').some(mark => wordAt(mark, 'kind') === 'text')
    const caseText = (arm: Form): string => {
      const literal = expressionOf(bridge, firstAt(arm, 'seed'))

      return literal?.form === 'string' ? literal.value : (wordAt(arm, 'name') ?? '').replace(/-/g, '_')
    }
    const variants = formsAt(value, 'case').map(arm => {
      // `case face, like face-rule` is a single-payload variant: its one field is called `value`
      const payload = typeOf(bridge, firstAt(arm, 'like'))
      // `slot` under a case is positional as it is under a form: `make conjunction(p, q)` fills the case's slots in
      // order. It was refused by the case grammar, which dropped the whole form and left every use of it undefined
      const armFields = [
        ...formsAt(arm, 'link').map(link => fieldOf(bridge, link)),
        ...formsAt(arm, 'slot-field').map(slot => ({ ...fieldOf(bridge, slot), positional: true })),
      ]
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
          ? [...armFields, { name: 'value', type: payload, span: spanOf(arm) }]
          : armFields,
        ...(indexValues.length > 0 ? { indexValues } : {}),
        ...(textual ? { text: caseText(arm) } : {}),
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
      // `mark shared`: one object through every binding. Written only when present, so every form that does not
      // say it builds the same Program it always did. `note shared`, the spelling from before `note` became text,
      // is still read, so the files that say it keep their meaning until they are rewritten
      ...(formsAt(value, 'mark').some(mark => wordAt(mark, 'kind') === 'shared') ||
      formsAt(value, 'note').some(note => wordAt(note, 'text') === 'shared')
        ? { shared: true }
        : {}),
      // `mark tag, name kind`: the field a union's TypeScript type and values discriminate on, so a port can keep
      // the shape the TypeScript it replaces declared (the checker's `Type` tags on `kind`, self-hosting-0020).
      // Written only when present and not `form`, so every other form builds the Program it always did. The
      // native backends emit enums, which have no tag field, and ignore it
      ...(tagOf(value) ? { tag: tagOf(value) } : {}),
      // `mark text` (D9): written only when present, so every other form builds the Program it always did
      ...(textual ? { text: true } : {}),
      // `mark deprecated`: a use of the form from another file warns, as a call of a deprecated task does
      // (check/deprecated.tree). Written only when present
      // (the mill reads `mark <word>` as `mark-note`, so the word arrives under `note`, as `shared`'s does)
      ...(formsAt(value, 'mark').some(mark => wordAt(mark, 'kind') === 'deprecated') ||
      formsAt(value, 'note').some(note => wordAt(note, 'text') === 'deprecated')
        ? { deprecated: true }
        : {}),
      ...(alias ? { alias } : {}),
      ...(extend ? { extend } : {}),
      functionFree:
        fields.every(f => f.type.kind !== 'function') &&
        variants.every(v =>
          v.fields.every(f => f.type.kind !== 'function'),
        ),
      span: spanOf(value),
    })

    // A `mark text` form's two conversions, written as ordinary Term tasks so every backend gets them the same way:
    // `to-text(value)` is the case's text, `from-text(text, fallback)` the case whose text it is, else the fallback.
    // On TypeScript a value already IS its text; natively it is an enum, and these are how it is printed and read.
    // Overloads by type, so two text forms in one file each have their own pair. A case that holds a value is refused
    // by name (check/text-forms.ts), so no pair is built for such a form: it would only fail first, in the kernel
    if (textual && variants.every(v => v.fields.length === 0)) {
      const span = spanOf(value)
      const self: Type = { kind: 'named', name }
      const text = (value: string): Expression => ({ form: 'string', value, span })
      const variable = (name: string): Expression => ({ form: 'variable', name, span })

      out.push({
        form: 'function',
        name: 'to-text',
        params: [{ name: 'value', type: self }],
        result: { kind: 'string' },
        generics: [],
        body: [
          {
            form: 'match',
            subject: variable('value'),
            cases: variants.map(v => ({
              label: v.name,
              body: [{ form: 'return', value: text(v.text ?? v.name), span }],
            })),
            span,
          },
        ],
        span,
      } as Statement)

      out.push({
        form: 'function',
        name: 'from-text',
        params: [
          { name: 'value', type: { kind: 'string' } },
          { name: 'fallback', type: self },
        ],
        result: self,
        generics: [],
        body: [
          ...variants.map(v => ({
            form: 'if',
            branches: [
              {
                cond: { form: 'binary', op: '==', left: variable('value'), right: text(v.text ?? v.name), span },
                body: [{ form: 'return', value: { form: 'record', name: v.name, fields: [], functionFree: true, span }, span }],
              },
            ],
            span,
          })),
          { form: 'return', value: variable('fallback'), span },
        ],
        span,
      } as unknown as Statement)
    }
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

    if (record.form === 'variable' && typeof record.name === 'string' && aliases.has(record.name)) {
      // kept, so binding sends it to the import even where the file defines the imported name itself
      record.alias = record.name
      record.name = aliases.get(record.name)!
    } else if (record.form === 'record' && typeof record.name === 'string' && aliases.has(record.name)) {
      // kept as a variable's is, so form binding sends `make chart-element` to the file its `find` named: it was
      // dropped, and both spellings bound to the form merged last (guides: language/modules, 2026-10-04)
      record.alias = record.name
      record.name = aliases.get(record.name)!
    } else if (record.form === 'call' && record.lean && Array.isArray(record.names)) {
      // a lean label that is an alias may be a nested call of the import: noted beside the label, left as written
      // `''` is no label, and no alias (compile/node.ts)
      const names = record.names as string[]

      if (names.some(name => name !== '' && aliases.has(name))) {
        record.leanAliases = names.map(name => (name === '' ? '' : (aliases.get(name) ?? '')))
      }
    } else if (
      record.kind === 'named' &&
      typeof record.name === 'string' &&
      aliases.has(record.name)
    ) {
      // `like chart-element`, kept for form binding the same way
      record.alias = record.name
      record.name = aliases.get(record.name)!
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
// `lean` is the set of `mine` rules marked `mark lean`, read off the same source. Optional on the type so the
// parity gate, which loads a grammar from disk and passes it in, keeps typechecking; a grammar without it
// simply has no lean rules, and the lean surface does nothing in it.
export type Grammar = {
  mine: MineGrammar
  mint: MintGrammar
  lean?: Set<string>
}

let baked: Grammar | undefined

function bakedGrammar(): Grammar {
  if (!baked) {
    const mine = parse({ file: 'code-mine.tree', text: MINE_SOURCE })
    const mint = parse({ file: 'code-mint.tree', text: MINT_SOURCE })

    baked = {
      mine: mine.ok ? readMineGrammar(mine.tree) : new Map(),
      mint: mint.ok ? readMintGrammar(mint.tree) : new Map(),
      lean: mine.ok ? readLeanRules(mine.tree) : new Set(),
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
  grammar: Grammar = bakedGrammar(),
  // `mark lean` on the file's role rule. The pass runs over the MATCH below, before anything mints, so every
  // reader downstream of it sees the longhand shape and cannot tell the two spellings apart. note/term/lean.md.
  lean?: boolean,
): MillResult {
  const named = namesInFile(tree)
  const bridge: Bridge = {
    file,
    role,
    lean,
    diagnostics: [],
    declared: new Set(),
    bound: new Set(),
    hostTask: named.has('host'),
    named,
    aliases: new Map(),
    grammar,
    twins: [],
    walks: { count: 0 },
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
      bridge.bound = new Set()
      program.push(...topLevelOf(bridge, value))
    }
  }

  if (bridge.diagnostics.length > 0) {
    return { ok: false, diagnostics: bridge.diagnostics }
  }

  applyAliases(bridge.aliases, program)

  return bridge.twins.length > 0 ? { ok: true, program, twins: bridge.twins } : { ok: true, program }
}
