// A LAW IN WORDS: every `rule` of a program as one plain English sentence, written from the rule's Term form alone, so a
// person approves what was proven and not what the author said was proven (note/project/term/assurance/prove-loop).
//
// It reads the mill's Program, the same statements the checker and the kernel read: a theorem (`rule` with a `show`) is
// a function marked `theorem` whose parameters are its `seat`s, whose `if` guards are its `have`s, whose `universals`
// are its `have`s with a `seat` of their own, and whose `hold` is its goal. A claim (`rule` with no `show`) is a function
// marked `claim` whose parameters are its `take`s and whose result is its `like`. Nothing reads a comment, and nothing
// reads the rule's NAME: both are prose an author (or an AI) wrote, and either may say something the law does not. A
// law named `strict-order-is-transitive` whose goal is `is-below c a` reads "then c is less than a", which is the point.
//
// WHAT THE SENTENCE IS. It is what the mill made of the rule, so it shows what the prover checks: `show miss is-below a a`
// reads "a is at least a", because the mill negates the comparison, and `like integer` reads "number", because the mill
// types an integer seat as a number. A sentence never claims more than the Program holds.
//
// THE WORDS. The operators the mill knows (`+`, `==`, `<=`, `&&` ...) each have a phrase. A call has a phrase only when
// its task is in LEXICON below. Any other task renders with its own name, `the lorentz-form of x and y`, and the
// sentence records the name in `words`: readable, faithful, but a word the renderer lacks. A shape the renderer cannot
// read (a closure, a conditional value, an `if` with an `otherwise`) is refused with the reason, never guessed.
//
// PARENTHESES are the one device for grouping, so a sentence has exactly one reading: an operand of `plus` or `followed
// by` is wrapped unless it is a single word, an argument of a phrase with two or more slots likewise, and a comparison
// is never wrapped, being the outermost thing in any proposition.

import { parse } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { headWord } from '@term/make/code/compile/mill-run'

// ---- the parts of the Program read here, as the mill builds them (compile/node.tree) ----

type TypeNode = {
  kind: string
  name?: string
  args?: TypeNode[]
  valueArgs?: ExpressionNode[]
  params?: TypeNode[]
  result?: TypeNode
  element?: TypeNode
  key?: TypeNode
  value?: TypeNode
  width?: string
}

type ExpressionNode = {
  form: string
  name?: string
  value?: unknown
  digits?: string
  op?: string
  left?: ExpressionNode
  right?: ExpressionNode
  operand?: ExpressionNode
  callee?: ExpressionNode
  args?: ExpressionNode[]
  names?: string[]
  leanNames?: boolean[]
  items?: ExpressionNode[]
  entries?: { key: ExpressionNode; value: ExpressionNode }[]
  fields?: { name: string; value: ExpressionNode }[]
  positional?: ExpressionNode[]
  target?: ExpressionNode
}

type StatementNode = {
  form: string
  name?: string
  init?: ExpressionNode
  expr?: ExpressionNode
  branches?: { cond: ExpressionNode; body: StatementNode[] }[]
  otherwise?: StatementNode[]
}

type ParamNode = { name: string; type?: TypeNode; refine?: string }

type RuleNode = {
  form: 'function'
  name: string
  params: ParamNode[]
  body: StatementNode[]
  generics?: { name: string }[]
  result?: TypeNode
  claim?: boolean
  theorem?: boolean
  axiom?: boolean
  universals?: {
    name: string
    binders: string[]
    expr: ExpressionNode
    types?: { type?: TypeNode }[]
  }[]
}

export type LawKind = 'theorem' | 'axiom' | 'claim'

// one rule in words. `text` is absent exactly when `refused` says why. `words` lists each task the sentence names by
// its own name for want of a phrase, in order of first use
export type LawSentence = {
  name: string
  kind: LawKind
  text?: string
  refused?: string
  words: string[]
}

// ---- the lexicon: a task whose meaning is fixed in the stdlib or the math library, and its phrase ----

type Phrase =
  // `A <word> B`, an operator between two values
  | { shape: 'infix'; word: string; logic?: boolean }
  // `<word> A`, chainable: `the reverse of the reverse of xs`
  | { shape: 'prefix'; word: string }
  // `<first> A <second> B`: `both a and b`, `the union of s and t`
  | { shape: 'pair'; first: string; second: string; logic?: boolean }

const LEXICON: Record<string, Phrase> = {
  plus: { shape: 'infix', word: 'plus' },
  times: { shape: 'infix', word: 'times' },
  minus: { shape: 'infix', word: 'minus' },
  monus: { shape: 'infix', word: 'minus (stopping at zero)' },
  power: { shape: 'infix', word: 'to the power of' },
  append: { shape: 'infix', word: 'followed by' },
  compose: { shape: 'infix', word: 'after' },
  apply: { shape: 'infix', word: 'applied to' },
  implies: { shape: 'infix', word: 'implies', logic: true },
  iff: { shape: 'infix', word: 'if and only if', logic: true },
  negate: { shape: 'prefix', word: 'the negative of' },
  reverse: { shape: 'prefix', word: 'the reverse of' },
  length: { shape: 'prefix', word: 'the length of' },
  complement: { shape: 'prefix', word: 'the complement of' },
  converse: { shape: 'prefix', word: 'the converse of' },
  conjugate: { shape: 'prefix', word: 'the conjugate of' },
  transpose: { shape: 'prefix', word: 'the transpose of' },
  determinant: { shape: 'prefix', word: 'the determinant of' },
  trace: { shape: 'prefix', word: 'the trace of' },
  both: { shape: 'pair', first: 'both', second: 'and', logic: true },
  either: { shape: 'pair', first: 'either', second: 'or', logic: true },
  xor: {
    shape: 'pair',
    first: 'exactly one of',
    second: 'and',
    logic: true,
  },
  union: { shape: 'pair', first: 'the union of', second: 'and' },
  intersection: {
    shape: 'pair',
    first: 'the intersection of',
    second: 'and',
  },
  max: { shape: 'pair', first: 'the larger of', second: 'and' },
  min: { shape: 'pair', first: 'the smaller of', second: 'and' },
  dot: { shape: 'pair', first: 'the dot product of', second: 'and' },
}

// the stdlib types whose meaning a reader needs said, by name
const TYPE_NOTE: Record<string, string> = {
  never: 'never, the type with no values',
}

const ARITHMETIC: Record<string, string> = {
  '+': 'plus',
  '-': 'minus',
  '*': 'times',
  '/': 'divided by',
  '%': 'modulo',
}

const RELATION: Record<string, string> = {
  '==': 'equals',
  '!=': 'does not equal',
  '<': 'is less than',
  '<=': 'is at most',
  '>': 'is greater than',
  '>=': 'is at least',
}

// ---- rendered pieces ----

// how a piece groups: a single word, a chainable prefix phrase, a phrase of two or more slots, a value operator, a
// comparison, a connective. It decides where parentheses go and nothing else
type Grain =
  | 'atom'
  | 'prefix'
  | 'phrase'
  | 'infix'
  | 'relation'
  | 'logic'

type Piece = { text: string; grain: Grain }

class Refuse extends Error {}

class Speaker {
  readonly words: string[] = []

  // `bound` holds every name a sentence quantifies over, so a call of one reads `f of x` and never `the f of x`
  constructor(private readonly bound: Set<string>) {}

  private missing(name: string): void {
    if (!this.words.includes(name)) {
      this.words.push(name)
    }
  }

  // an operand of a value operator, or an argument of a phrase of two or more slots
  tight(piece: Piece): string {
    return piece.grain === 'atom' ? piece.text : `(${piece.text})`
  }

  // the one argument of a prefix phrase: a prefix chains, anything with slots or an operator is wrapped
  chained(piece: Piece): string {
    return piece.grain === 'atom' || piece.grain === 'prefix'
      ? piece.text
      : `(${piece.text})`
  }

  // a side of a comparison: a single word, a prefix chain or a value operator stands bare, anything with an "and" of
  // its own between slots is wrapped, so `(the product of m and n) equals p` has one reading
  loose(piece: Piece): string {
    return piece.grain === 'relation' ||
      piece.grain === 'logic' ||
      piece.grain === 'phrase'
      ? `(${piece.text})`
      : piece.text
  }

  list(texts: string[]): string {
    if (texts.length <= 1) {
      return texts[0] ?? ''
    }

    return `${texts.slice(0, -1).join(', ')} and ${texts[texts.length - 1]}`
  }

  // a value, where a number, a list or a truth value may stand
  value(node: ExpressionNode): Piece {
    switch (node.form) {
      case 'variable':
        return { text: node.name ?? '?', grain: 'atom' }
      case 'integer':
        return {
          text: node.digits ?? String(node.value),
          grain: 'atom',
        }
      case 'float':
        return { text: String(node.value), grain: 'atom' }
      case 'boolean':
        return { text: node.value ? 'true' : 'false', grain: 'atom' }
      case 'string':
        return { text: `"${String(node.value)}"`, grain: 'atom' }
      case 'unit':
        return { text: 'nothing', grain: 'atom' }
      case 'binary':
        return this.binary(node)
      case 'unary':
        return this.unary(node)
      case 'call':
        return this.call(node, false)
      case 'record':
        return this.record(node)

      case 'member': {
        const target = this.value(node.target!)

        return {
          text: `the ${node.name} of ${this.chained(target)}`,
          grain: 'prefix',
        }
      }

      case 'array': {
        const items = (node.items ?? []).map(item =>
          this.tight(this.value(item)),
        )

        return items.length === 0
          ? { text: 'the empty list', grain: 'atom' }
          : { text: `the list of ${this.list(items)}`, grain: 'phrase' }
      }

      case 'map': {
        const entries = (node.entries ?? []).map(
          entry =>
            `${this.tight(this.value(entry.key))} to ${this.tight(this.value(entry.value))}`,
        )

        return entries.length === 0
          ? { text: 'the empty map', grain: 'atom' }
          : {
              text: `the map from ${this.list(entries)}`,
              grain: 'phrase',
            }
      }

      default:
        throw new Refuse(
          `a ${node.form} expression, which has no reading in words yet`,
        )
    }
  }

  // a proposition: what a goal, a hypothesis or a connective's operand states
  proposition(node: ExpressionNode): Piece {
    if (node.form === 'call') {
      return this.call(node, true)
    }

    return this.value(node)
  }

  private binary(node: ExpressionNode): Piece {
    const op = node.op ?? ''
    const left = node.left!
    const right = node.right!

    if (op === '&&' || op === '||') {
      const [first, second] =
        op === '&&' ? ['both', 'and'] : ['either', 'or']

      return {
        text: `${first} ${this.connected(this.proposition(left))} ${second} ${this.connected(this.proposition(right))}`,
        grain: 'logic',
      }
    }

    const relation = RELATION[op]

    if (relation) {
      return {
        text: `${this.loose(this.value(left))} ${relation} ${this.loose(this.value(right))}`,
        grain: 'relation',
      }
    }

    const arithmetic = ARITHMETIC[op]

    if (arithmetic) {
      return {
        text: `${this.tight(this.value(left))} ${arithmetic} ${this.tight(this.value(right))}`,
        grain: 'infix',
      }
    }

    throw new Refuse(
      `the operator ${op}, which has no reading in words yet`,
    )
  }

  // an operand of `both`, `either` or `not`: anything but a single word or a prefix chain is wrapped, since the
  // connective's own "and" would otherwise run into the operand's (`both (r holds of u and v) and ...`)
  private connected(piece: Piece): string {
    return piece.grain === 'atom' || piece.grain === 'prefix'
      ? piece.text
      : `(${piece.text})`
  }

  private unary(node: ExpressionNode): Piece {
    const operand = node.operand!

    if (node.op === '!') {
      return {
        text: `it is not true that ${this.connected(this.proposition(operand))}`,
        grain: 'logic',
      }
    }

    if (node.op === '-') {
      const inner = this.value(operand)

      return inner.grain === 'atom'
        ? { text: `negative ${inner.text}`, grain: 'atom' }
        : {
            text: `the negative of ${this.chained(inner)}`,
            grain: 'prefix',
          }
    }

    throw new Refuse(
      `the operator ${node.op}, which has no reading in words yet`,
    )
  }

  // A lean call keeps a nested call as a NAMED argument: `apply(compose(g, f), x)` mills as `apply` with arguments
  // `[g, f]` named `compose` and marked lean, then `x`. Each such argument is the call it was written as.
  private argumentsOf(node: ExpressionNode): ExpressionNode[] {
    const args = node.args ?? []

    return args.map((arg, at) => {
      const named = node.names?.[at]

      if (named && node.leanNames?.[at] === true) {
        const items = arg.form === 'array' ? (arg.items ?? []) : [arg]

        return {
          form: 'call',
          callee: { form: 'variable', name: named },
          args: items,
        }
      }

      return arg
    })
  }

  private call(node: ExpressionNode, asProposition: boolean): Piece {
    const callee = node.callee

    if (callee?.form !== 'variable' || !callee.name) {
      throw new Refuse('a call whose callee is not a name')
    }

    const name = callee.name
    const args = this.argumentsOf(node)

    // a call of a quantified function or property: `f of x`, `p holds of x`, `r of x and y`
    if (this.bound.has(name)) {
      return this.applied(name, args, asProposition)
    }

    const phrase = LEXICON[name]

    if (phrase?.shape === 'infix' && args.length === 2) {
      // a connective between truth values (`implies`) groups like `both`, so a comparison around it wraps it
      return {
        text: `${this.tight(this.value(args[0]!))} ${phrase.word} ${this.tight(this.value(args[1]!))}`,
        grain: phrase.logic ? 'logic' : 'infix',
      }
    }

    if (phrase?.shape === 'prefix' && args.length === 1) {
      return {
        text: `${phrase.word} ${this.chained(this.value(args[0]!))}`,
        grain: 'prefix',
      }
    }

    if (phrase?.shape === 'pair' && args.length === 2) {
      const read = (arg: ExpressionNode): string =>
        phrase.logic
          ? this.connected(this.proposition(arg))
          : this.tight(this.value(arg))

      return {
        text: `${phrase.first} ${read(args[0]!)} ${phrase.second} ${read(args[1]!)}`,
        grain: phrase.logic ? 'logic' : 'phrase',
      }
    }

    // no phrase: the task's own name, and the name is recorded as a word the renderer lacks
    this.missing(name)

    if (args.length === 0) {
      return { text: name, grain: 'atom' }
    }

    if (asProposition && name.startsWith('is-')) {
      const [subject, ...rest] = args.map(arg =>
        this.tight(this.value(arg)),
      )

      return {
        text: [subject, 'is', name.slice(3), ...rest].join(' '),
        grain: 'relation',
      }
    }

    return this.applied(name, args, asProposition, 'the ')
  }

  private applied(
    name: string,
    args: ExpressionNode[],
    asProposition: boolean,
    article = '',
  ): Piece {
    if (asProposition) {
      const texts = args.map(arg => this.tight(this.value(arg)))

      return {
        text: `${name} holds of ${this.list(texts)}`,
        grain: 'relation',
      }
    }

    if (args.length === 1) {
      return {
        text: `${article}${name} of ${this.chained(this.value(args[0]!))}`,
        grain: 'prefix',
      }
    }

    return {
      text: `${article}${name} of ${this.list(args.map(arg => this.tight(this.value(arg))))}`,
      grain: 'phrase',
    }
  }

  // a value of a form's case: `zero`, `cons with item h and more t`, `matrix-two of a, b, c and d`
  private record(node: ExpressionNode): Piece {
    const name = node.name ?? '?'
    const fields = node.fields ?? []
    const positional = node.positional ?? []

    if (fields.length === 0 && positional.length === 0) {
      return { text: name, grain: 'atom' }
    }

    if (positional.length > 0) {
      return {
        text: `${name} of ${this.list(positional.map(item => this.tight(this.value(item))))}`,
        grain: positional.length === 1 ? 'prefix' : 'phrase',
      }
    }

    // one field reads like a prefix and chains: `succ with prior (the length of t)`
    const parts = fields.map(
      field => `${field.name} ${this.tight(this.value(field.value))}`,
    )

    return {
      text: `${name} with ${this.list(parts)}`,
      grain: fields.length === 1 ? 'prefix' : 'phrase',
    }
  }
}

// ---- types, as the noun a quantifier takes ----

type Noun = { singular: string; plural: string; after: string }

function pluralOf(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) {
    return `${word}es`
  }

  if (/[^aeiou]y$/.test(word)) {
    return `${word.slice(0, -1)}ies`
  }

  return `${word}s`
}

function plainNoun(word: string): Noun {
  // the plural goes on the last word: `natural numbers`
  const parts = word.split(' ')
  const last = parts.pop()!

  return {
    singular: word,
    plural: [...parts, pluralOf(last)].join(' '),
    after: '',
  }
}

class Typist {
  constructor(private readonly generics: Set<string>) {}

  // a type as a short name inside another phrase: `a`, `number`, `roll`, `set of a`
  short(type: TypeNode | undefined): string {
    if (!type) {
      return 'any type'
    }

    switch (type.kind) {
      case 'number':
        return type.width ? `${type.width} number` : 'number'
      case 'float':
        return 'decimal number'
      case 'boolean':
        return 'truth value'
      case 'string':
        return 'text'
      case 'unit':
        return 'nothing'
      case 'array':
        return `list of ${this.inner(type.element)}`
      case 'map':
        return `map from ${this.inner(type.key)} to ${this.inner(type.value)}`

      case 'named': {
        // a type indexed by values inside another type (`function from natural and below m n to p`) names values
        // bound by a dependent function, which no sentence here can show. Refused rather than said without them
        if (type.valueArgs?.length) {
          throw new Refuse(
            `the value-indexed type ${type.name} inside another type, which has no reading in words yet`,
          )
        }

        const args = type.args ?? []

        return args.length === 0
          ? (type.name ?? '?')
          : `${type.name} of ${args.map(arg => this.inner(arg)).join(' and ')}`
      }

      case 'function':
        return `function from ${(type.params ?? []).map(p => this.inner(p)).join(' and ')} to ${this.inner(type.result)}`
      default:
        return 'any type'
    }
  }

  // a type inside another type: one with words of its own is wrapped, so `function from (function from a to b) to c`
  // has one reading
  inner(type: TypeNode | undefined): string {
    const text = this.short(type)

    return text.includes(' ') ? `(${text})` : text
  }

  // the noun a quantifier puts before the names, and what follows them: `every function f from a to b`
  noun(type: TypeNode | undefined, refine?: string): Noun {
    if (!type || type.kind === 'unknown' || type.kind === 'variable') {
      return plainNoun('value')
    }

    if (type.kind === 'number' && refine === 'natural') {
      return plainNoun('natural number')
    }

    if (
      type.kind === 'named' &&
      type.name &&
      this.generics.has(type.name) &&
      !type.args?.length
    ) {
      return {
        singular: 'value',
        plural: 'values',
        after: ` of type ${type.name}`,
      }
    }

    if (type.kind === 'function') {
      const from = (type.params ?? [])
        .map(p => this.inner(p))
        .join(' and ')

      // a function to `type` is a property of its argument, and a call of it a proposition
      if (
        type.result?.kind === 'named' &&
        type.result.name === 'type'
      ) {
        return {
          singular: 'property',
          plural: 'properties',
          after: ` of values of type ${from}`,
        }
      }

      return {
        singular: 'function',
        plural: 'functions',
        after: ` from ${from} to ${this.inner(type.result)}`,
      }
    }

    if (type.kind === 'array') {
      return {
        singular: 'list',
        plural: 'lists',
        after: ` of ${this.inner(type.element)}`,
      }
    }

    if (type.kind === 'named' && type.args?.length) {
      return {
        ...plainNoun(type.name ?? '?'),
        after: ` of ${type.args.map(arg => this.inner(arg)).join(' and ')}`,
      }
    }

    return plainNoun(this.short(type))
  }
}

// `every number a`, `all numbers a, b and c`, joined in order, consecutive names of one noun grouped
function quantified(
  binders: { name: string; noun: Noun }[],
  speaker: Speaker,
): string {
  const groups: { noun: Noun; names: string[] }[] = []

  for (const binder of binders) {
    const last = groups[groups.length - 1]

    if (
      last?.noun.singular === binder.noun.singular &&
      last.noun.after === binder.noun.after
    ) {
      last.names.push(binder.name)
    } else {
      groups.push({ noun: binder.noun, names: [binder.name] })
    }
  }

  return speaker.list(
    groups.map(group =>
      group.names.length === 1
        ? `every ${group.noun.singular} ${group.names[0]}${group.noun.after}`
        : `all ${group.noun.plural} ${speaker.list(group.names)}${group.noun.after}`,
    ),
  )
}

function sentence(
  parts: {
    quantifier: string
    where: string[]
    hypotheses: string[]
    goal: string
  },
  speaker: Speaker,
): string {
  let text = ''

  if (parts.quantifier) {
    text += `for ${parts.quantifier}, `
  }

  for (const where of parts.where) {
    text += `where ${where}, `
  }

  if (parts.hypotheses.length > 0) {
    // among several hypotheses, one with an "and" or "or" of its own is wrapped, or the list's "and" runs into it. One
    // that quantifies its own variable carries commas, so the joins become ", and" to keep one reading
    const own = /\b(and|or)\b/
    const hypotheses =
      parts.hypotheses.length > 1
        ? parts.hypotheses.map(h => (own.test(h) ? `(${h})` : h))
        : parts.hypotheses

    const join = hypotheses.some(
      h => h.includes(',') && !h.startsWith('('),
    )
      ? hypotheses.join(', and ')
      : speaker.list(hypotheses)

    text += `if ${join}, then `
  }

  text += parts.goal

  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

// ---- theorems and axioms ----

function theoremText(rule: RuleNode): {
  text: string
  words: string[]
} {
  const generics = new Set((rule.generics ?? []).map(g => g.name))
  const typist = new Typist(generics)
  const bound = new Set(rule.params.map(p => p.name))
  const where: { name: string; init: ExpressionNode }[] = []
  const conditions: ExpressionNode[] = []

  let goal: ExpressionNode | undefined

  const axiomParts: ExpressionNode[] = []

  // the body the bridge builds: witnesses as `let`, plain hypotheses as nested `if`, the goal as one `hold`. An axiom's
  // hypotheses and claim are `let`s named for them, the claim last
  const walk = (body: StatementNode[]): void => {
    for (const statement of body) {
      if (statement.form === 'return') {
        continue
      }

      if (statement.form === 'let' && statement.init) {
        if (rule.axiom) {
          axiomParts.push(statement.init)
        } else {
          where.push({
            name: statement.name ?? '?',
            init: statement.init,
          })
          bound.add(statement.name ?? '?')
        }

        continue
      }

      if (statement.form === 'if') {
        const branches = statement.branches ?? []

        if (branches.length !== 1 || statement.otherwise) {
          throw new Refuse(
            'an `if` that is not one guard around the goal',
          )
        }

        conditions.push(branches[0]!.cond)
        walk(branches[0]!.body)
        continue
      }

      if (statement.form === 'hold' && statement.expr) {
        if (goal) {
          throw new Refuse('two goals in one rule')
        }

        goal = statement.expr
        continue
      }

      throw new Refuse(
        `a ${statement.form} statement in the rule's body`,
      )
    }
  }

  walk(rule.body)

  if (rule.axiom) {
    goal = axiomParts.pop()
    conditions.push(...axiomParts)
  }

  if (!goal) {
    throw new Refuse('a rule with no goal')
  }

  for (const universal of rule.universals ?? []) {
    universal.binders.forEach(name => bound.add(name))
  }

  const speaker = new Speaker(bound)
  const binders = rule.params.map(p => ({
    name: p.name,
    noun: typist.noun(p.type, p.refine),
  }))

  const typeBinders = (rule.generics ?? []).map(g => ({
    name: g.name,
    noun: plainNoun('type'),
  }))

  const hypotheses: string[] = []

  for (const universal of rule.universals ?? []) {
    const inner = universal.binders.map((name, at) => ({
      name,
      noun: typist.noun(universal.types?.[at]?.type),
    }))

    hypotheses.push(
      `for ${quantified(inner, speaker)}, ${speaker.proposition(universal.expr).text}`,
    )
  }

  for (const condition of conditions) {
    hypotheses.push(speaker.proposition(condition).text)
  }

  let text = sentence(
    {
      quantifier: quantified([...typeBinders, ...binders], speaker),
      where: where.map(
        w => `${w.name} is ${speaker.value(w.init).text}`,
      ),
      hypotheses,
      goal: speaker.proposition(goal).text,
    },
    speaker,
  )

  if (rule.axiom) {
    text = `Assumed without proof: ${text.charAt(0).toLowerCase()}${text.slice(1)}`
  }

  return { text, words: speaker.words }
}

// ---- claims: a name at a type, read as a proposition ----

// A claim's type says what it proves. A parameter whose type is a proposition is a hypothesis, any other is a value
// it holds for, and the result is the conclusion. A proposition is the equality family, the empty type, a property a
// parameter names applied to values, or a family indexed by values.
function claimText(rule: RuleNode): { text: string; words: string[] } {
  const generics = new Set((rule.generics ?? []).map(g => g.name))
  const typist = new Typist(generics)
  const properties = new Set(
    rule.params
      .filter(
        p =>
          p.type?.kind === 'function' &&
          p.type.result?.kind === 'named' &&
          p.type.result.name === 'type',
      )
      .map(p => p.name),
  )

  const isProposition = (type: TypeNode | undefined): boolean =>
    type?.kind === 'named' &&
    (type.name === 'equal' ||
      type.name === 'never' ||
      (type.valueArgs?.length ?? 0) > 0)

  const values = rule.params.filter(p => !isProposition(p.type))
  const speaker = new Speaker(new Set(values.map(p => p.name)))

  const said = (type: TypeNode): string => {
    if (type.name === 'equal' && type.valueArgs?.length === 2) {
      return `${speaker.loose(speaker.value(type.valueArgs[0]!))} equals ${speaker.loose(speaker.value(type.valueArgs[1]!))}`
    }

    if (TYPE_NOTE[type.name ?? '']) {
      return `there is a value of ${TYPE_NOTE[type.name ?? '']}`
    }

    const args = (type.valueArgs ?? []).map(arg =>
      speaker.tight(speaker.value(arg)),
    )

    // a family the claim does not quantify over is named by its own name, a word the renderer lacks
    if (
      !properties.has(type.name ?? '') &&
      !speaker.words.includes(type.name ?? '?')
    ) {
      speaker.words.push(type.name ?? '?')
    }

    return `${type.name} holds of ${speaker.list(args)}`
  }

  const conclusion = (type: TypeNode | undefined): string => {
    if (!type) {
      throw new Refuse('a claim with no result type')
    }

    return isProposition(type)
      ? said(type)
      : `there is a value of type ${typist.short(type)}`
  }

  const typeBinders = (rule.generics ?? []).map(g => ({
    name: g.name,
    noun: plainNoun('type'),
  }))

  const binders = values.map(p => ({
    name: p.name,
    noun: typist.noun(p.type, p.refine),
  }))

  const hypotheses = rule.params
    .filter(p => isProposition(p.type))
    .map(p => said(p.type!))

  return {
    text: sentence(
      {
        quantifier: quantified([...typeBinders, ...binders], speaker),
        where: [],
        hypotheses,
        goal: conclusion(rule.result),
      },
      speaker,
    ),
    words: speaker.words,
  }
}

// ---- the public face ----

function isRule(statement: unknown): statement is RuleNode {
  const s = statement as RuleNode

  return (
    s.form === 'function' &&
    (s.claim === true || s.theorem === true || s.axiom === true)
  )
}

// every rule of a milled program in words, in the order written. A claim is filled by a task of its name, which is a
// separate statement and never read here: the sentence is the claim, not its proof
export function lawSentences(
  program: readonly unknown[],
): LawSentence[] {
  const out: LawSentence[] = []

  for (const statement of program) {
    if (!isRule(statement)) {
      continue
    }

    const kind: LawKind =
      statement.claim && !statement.theorem
        ? 'claim'
        : statement.axiom
          ? 'axiom'
          : 'theorem'

    try {
      const { text, words } =
        kind === 'claim' ? claimText(statement) : theoremText(statement)

      out.push({ name: statement.name, kind, text, words })
    } catch (error) {
      if (error instanceof Refuse) {
        out.push({
          name: statement.name,
          kind,
          refused: error.message,
          words: [],
        })
      } else {
        throw error
      }
    }
  }

  return out
}

export type LawSource = {
  file: string
  text: string
  role?: string
  lean?: boolean
}

// one `.tree` source to its rules in words, through the parser and the mill the build runs. A source that does not
// parse or mill returns the first diagnostic instead, and how many top-level `rule`s the parse tree holds, so a count
// over many files can say what a file it could not mill would have added
export function lawSentencesOf(
  source: LawSource,
):
  | { ok: true; laws: LawSentence[] }
  | { ok: false; error: string; rules: number } {
  const parsed = parse({ file: source.file, text: source.text })

  if (!parsed.ok) {
    return {
      ok: false,
      error: `parse: ${parsed.diagnostics[0]?.message ?? 'failed'}`,
      rules: 0,
    }
  }

  const built = mill(
    expandTemplates(parsed.tree),
    source.file,
    source.role,
    source.lean,
  )

  if (!built.ok) {
    const rules = parsed.tree.nodes.filter(
      node => node.kind === 'group' && headWord(node) === 'rule',
    ).length

    return {
      ok: false,
      error: `mill: ${built.diagnostics[0]?.message ?? 'failed'}`,
      rules,
    }
  }

  return { ok: true, laws: lawSentences(built.program) }
}
