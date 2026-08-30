// The feed mill compiler: reads a @term/feed dialect's mine.tree grammar and GENERATES real Term (.tree) source
// text implementing the reader — compiled ahead of time through the ordinary parse/mill/check/emit pipeline onto
// every backend, not interpreted at parse time. Modeled on mill-run.ts's own shape (grammar file -> rule objects
// -> a pass over them), reusing its generic ".tree CST -> word/phrase/text" readers, but for a DIFFERENT
// problem: mill-run.ts matches an already-parsed .tree CST (Term's own syntax) onto a typed shape; this reads
// raw BYTES or CHARACTERS of an arbitrary format (hex digits, gzip, JSON, ...) against
// `@term/feed/code/base.tree`'s `feed-cursor`/`text-cursor` primitives. See note/term/project/feed-compiler.md.
//
// Scope, honestly: the rule kinds `hex` and `gzip`'s real grammars use are implemented (list, form, any, range,
// byte, int, bytes, maybe, until, let, value, send) — proven end to end against both dialects' hand-written
// readers, not assumed. Extending to json/OTF/PDF needs more (case for a tagged-union dispatch, offset-relative
// `at` for OTF's random-access tables, count-directed list) the same way mill-self-hosting grew its own rule
// vocabulary role by role, each one checked before the next.
//
// Every construct that needs a runtime decision (`mine any`, `mine byte` with a literal to enforce, `mine
// maybe`) compiles to its OWN helper task returning via `send back` inside each branch — never a `save` read
// again after the fork closes. `save` inside a `fork test`/`fork case` branch is scoped to that branch, not the
// enclosing task (feedback_term_fork_case_param_shadow's sibling finding, hit and fixed by hand several times
// this session); `send back` has no such problem, since it exits the whole task immediately regardless of which
// branch it's in.

import type { GroupNode, Node, RootNode } from '@term/make/code/parser/tree'
import { headWord, textOf, wordOf } from './mill-run'

// ---- reading the mine grammar into rule objects ----

export type FeedMineRule =
  | { kind: 'list'; children: FeedMineRule[] }
  | { kind: 'any'; children: FeedMineRule[]; send?: string }
  | { kind: 'range'; base: string; head: string }
  | { kind: 'form'; name: string; send?: string }
  | { kind: 'value'; expr: GroupNode }
  | { kind: 'send'; name: string }
  | { kind: 'byte'; literal?: number; send?: string }
  | { kind: 'int'; width: number; order: 'big' | 'little'; sign: 'signed' | 'unsigned'; send?: string }
  | { kind: 'bytes'; width: GroupNode; send?: string }
  | { kind: 'maybe'; test: GroupNode; children: FeedMineRule[]; send?: string }
  | { kind: 'until'; terminator: number; send?: string }
  | { kind: 'let'; name: string; expr: GroupNode }

export type FeedMineGrammar = Map<string, FeedMineRule[]>

// a standalone `send <name>` that follows a value-producing rule renames THAT rule's own capture — it never
// introduces a second, disconnected local (`mine form` already carries its own nested `send` from
// `readFeedMineRule`'s `form` case; this is for every OTHER kind, where `send` is a trailing sibling instead).
// Runs once over every rules array as it's built, so a compiler pass never has to guess which capture a trailing
// `send` belongs to.
const SENDABLE = new Set(['any', 'byte', 'int', 'bytes', 'until', 'form', 'maybe'])

function mergeSends(rules: FeedMineRule[]): FeedMineRule[] {
  const out: FeedMineRule[] = []

  for (const rule of rules) {
    const prior = out[out.length - 1] as { send?: string } | undefined

    if (rule.kind === 'send' && prior && SENDABLE.has((prior as { kind: string }).kind) && !prior.send) {
      prior.send = rule.name

      continue
    }

    out.push(rule)
  }

  return out
}

// `bind <key>, <value>` is the comma form throughout every mine.tree in this package: `bind`'s own children are
// THREE flat siblings (bind-name, key, value), never the value nested inside the key — confirmed against the
// real parse of hex/mine.tree's `bind base, text <0>`, not assumed from the paren/stacked-form reasoning that
// caused `printNode`'s `call` bug (see its own comment).
function bindValueGroup(group: GroupNode, name: string): GroupNode | undefined {
  for (const child of group.nodes) {
    if (child.kind === 'group' && headWord(child) === 'bind' && wordOf(child.nodes[1]) === name) {
      const value = child.nodes[2]

      return value?.kind === 'group' ? value : undefined
    }
  }

  return undefined
}

// `bindValueGroup` gets the raw `<value>` group; these three unwrap it for the three literal shapes a `bind`
// actually carries in this package: `text <...>`, `code <n>`, and `term <word>` (an enum-case reference, e.g.
// `bind order, term little`).
function bindTextOf(group: GroupNode, name: string): string | undefined {
  const value = bindValueGroup(group, name)
  const inner = value?.kind === 'group' && headWord(value) === 'text' ? value.nodes[1] : undefined

  return inner ? textOf(inner) : undefined
}

function bindCodeOf(group: GroupNode, name: string): number | undefined {
  const value = bindValueGroup(group, name)
  const inner = value?.kind === 'group' && headWord(value) === 'code' ? value.nodes[1] : undefined

  return inner && (inner.kind === 'integer' || inner.kind === 'decimal' || inner.kind === 'radix') ? inner.value : undefined
}

function bindWordOf(group: GroupNode, name: string): string | undefined {
  const value = bindValueGroup(group, name)

  return value?.kind === 'group' && headWord(value) === 'term' ? wordOf(value.nodes[1]) : undefined
}

// the numeric value of a bare `code <n>` group (not a `bind`'s value — a direct child, as in `mine byte, code
// 0x1f`'s literal).
function codeValueOf(group: GroupNode): number | undefined {
  const inner = group.nodes[1]

  return inner && (inner.kind === 'integer' || inner.kind === 'decimal' || inner.kind === 'radix') ? inner.value : undefined
}

// every rule kind's "what comes after the kind word" lives at `group.nodes.slice(2)` — confirmed empirically
// against hex's and gzip's real files for every shape this package's mine.tree files actually use (the comma
// form, `mine form, form x`, and the bare-word-then-indent form, `mine range` / indented `bind`s, both land
// their extra content there; only an embedded Term expression like `call add(...)`'s own callee argument
// nesting works differently, and `printNode` handles that separately, not this reader).
function siblingsOf(group: GroupNode): Node[] {
  return group.nodes.slice(2)
}

// `mine byte / send flags`: `send` NESTED directly inside a single-line rule's own group, the same way `mine
// form, form X / send Y` already carries its send. Different from the standalone-sibling `send` a `mine any` or
// `mine maybe`'s body needs `mergeSends` for — a bare single-line construct like `byte`/`int`/`bytes`/`until`
// never has more than one thing following it, so it can just look for its own nested `send` directly, the same
// way `form`'s case already does.
function nestedSend(group: GroupNode): string | undefined {
  const sendGroup = siblingsOf(group).find((n): n is GroupNode => n.kind === 'group' && headWord(n) === 'send')

  return sendGroup ? wordOf(sendGroup.nodes[1]) : undefined
}

function readFeedMineRule(group: GroupNode): FeedMineRule | undefined {
  const head = headWord(group)

  if (head === 'send') {
    const name = wordOf(group.nodes[1])

    return name ? { kind: 'send', name } : undefined
  }

  if (head !== 'mine') {
    return undefined
  }

  const kind = wordOf(group.nodes[1])
  const rawChildren = (): GroupNode[] => siblingsOf(group).filter((n): n is GroupNode => n.kind === 'group')
  const children = (): FeedMineRule[] => {
    const out: FeedMineRule[] = []

    for (const child of rawChildren()) {
      const rule = readFeedMineRule(child)

      if (rule) {
        out.push(rule)
      }
    }

    return mergeSends(out)
  }

  switch (kind) {
    case 'list':
      return { kind: 'list', children: children() }

    case 'any':
      return { kind: 'any', children: children() }

    case 'range': {
      const base = bindTextOf(group, 'base')
      const head2 = bindTextOf(group, 'head')

      return base && head2 ? { kind: 'range', base, head: head2 } : undefined
    }

    case 'form': {
      const formGroup = rawChildren().find(n => headWord(n) === 'form')
      const name = formGroup ? wordOf(formGroup.nodes[1]) : undefined
      const sendGroup = rawChildren().find(n => headWord(n) === 'send')
      const send = sendGroup ? wordOf(sendGroup.nodes[1]) : undefined

      return name ? { kind: 'form', name, send } : undefined
    }

    case 'value': {
      // the value is an arbitrary Term expression: the first child group, re-emitted verbatim by `printNode`,
      // never interpreted here
      const exprGroup = rawChildren()[0]

      return exprGroup ? { kind: 'value', expr: exprGroup } : undefined
    }

    case 'byte': {
      const literalGroup = rawChildren().find(n => headWord(n) === 'code')
      const literal = literalGroup ? codeValueOf(literalGroup) : undefined

      return { kind: 'byte', literal, send: nestedSend(group) }
    }

    case 'int': {
      const width = bindCodeOf(group, 'width')
      const order = bindWordOf(group, 'order')
      const sign = bindWordOf(group, 'sign')

      if (width === undefined || (order !== 'big' && order !== 'little') || (sign !== 'signed' && sign !== 'unsigned')) {
        return undefined
      }

      return { kind: 'int', width, order, sign, send: nestedSend(group) }
    }

    case 'bytes': {
      const width = bindValueGroup(group, 'width')

      return width ? { kind: 'bytes', width, send: nestedSend(group) } : undefined
    }

    case 'maybe': {
      const testGroup = rawChildren().find(n => headWord(n) === 'test')
      // `test`'s own child starts at `nodes[1]` (`test` itself is `nodes[0]`, not `mine` + a kind word), unlike
      // every `mine <kind>` construct `siblingsOf` is built for (content at `nodes[2]`) — confirmed against a
      // real parse of gzip's `test / call bitwise-and(...)`, not assumed from the `mine value` shape, which
      // looked similar but isn't: this bug shipped once already from that exact assumption.
      const testExpr = testGroup ? testGroup.nodes.slice(1).find((n): n is GroupNode => n.kind === 'group') : undefined
      // `send <name>` trailing a `maybe`'s body names the MAYBE'S OWN result (what a later `mine value` in the
      // enclosing rule reads back), not one more capture fed into the body — the body's own internal capture
      // (what `some(value: ...)` is built from inside the maybe's own helper task) is unrelated and can stay
      // auto-named. Confirmed against gzip's real grammar: `mine maybe / test.../ mine form, form extra-field /
      // send extra` means "call the whole maybe's result `extra`", not "rename extra-field's own capture".
      const sendGroup = rawChildren().find(n => headWord(n) === 'send')
      const send = sendGroup ? wordOf(sendGroup.nodes[1]) : undefined
      const bodyRules: FeedMineRule[] = []

      for (const child of rawChildren()) {
        if (child === testGroup || child === sendGroup) {
          continue
        }

        const rule = readFeedMineRule(child)

        if (rule) {
          bodyRules.push(rule)
        }
      }

      return testExpr ? { kind: 'maybe', test: testExpr, children: mergeSends(bodyRules), send } : undefined
    }

    case 'until': {
      const inner = rawChildren().find(n => headWord(n) === 'mine')
      const innerRule = inner ? readFeedMineRule(inner) : undefined

      return innerRule && innerRule.kind === 'byte' && innerRule.literal !== undefined
        ? { kind: 'until', terminator: innerRule.literal, send: nestedSend(group) }
        : undefined
    }

    case 'let': {
      const nameGroup = rawChildren().find(n => headWord(n) === 'name')
      const name = nameGroup ? wordOf(nameGroup.nodes[1]) : undefined
      const exprGroup = rawChildren().find(n => n !== nameGroup)

      return name && exprGroup ? { kind: 'let', name, expr: exprGroup } : undefined
    }

    default:
      return undefined
  }
}

export function readFeedMineGrammar(tree: RootNode): FeedMineGrammar {
  const grammar: FeedMineGrammar = new Map()

  for (const group of tree.nodes) {
    if (headWord(group) !== 'mine') {
      continue
    }

    const name = wordOf(group.nodes[1])

    if (!name) {
      continue
    }

    const rules: FeedMineRule[] = []

    for (const child of siblingsOf(group)) {
      if (child.kind === 'group') {
        const rule = readFeedMineRule(child)

        if (rule) {
          rules.push(rule)
        }
      }
    }

    grammar.set(name, mergeSends(rules))
  }

  return grammar
}

// ---- printing an embedded Term expression node back to .tree source text ----
//
// `mine value`'s content is already a valid Term syntax fragment; this reconstructs it as text rather than
// parsing it semantically, since the ordinary compiler pipeline (parse -> mill -> check) does that job once the
// generated file goes through it. Every group prints in the PAREN form (`head(a, b, c)`), which CLAUDE.md's own
// comma-chain rule confirms is always equivalent to the stacked/comma forms, so this doesn't need to replicate
// whichever the source originally used.
export function printNode(node: Node, depth = 0): string {
  switch (node.kind) {
    case 'name':
      return wordOf(node) ?? ''
    case 'text':
      return `text <${textOf(node)}>`
    case 'integer':
    case 'decimal':
    case 'radix':
      return `code ${node.value}`
    case 'group': {
      const head = node.nodes[0]

      if (!head) {
        return ''
      }

      const headName = wordOf(head)

      // `make X / bind a, V1 / bind b, V2` MUST stay in the stacked, indented form, never `make X(bind a, V1,
      // bind b, V2)`: nesting a `bind key, value` pair as one of several comma-separated arguments inside an
      // OUTER paren breaks the pairing, because a comma always resets to the nearest ENCLOSING paren, not to
      // `bind`'s own scope — `bind method, read method` inside `make gzip-file(...)` re-parses as FOUR flat
      // siblings of `gzip-file` (`bind{method}`, `read{method}`, ...) instead of two `bind` pairs. Confirmed by
      // parsing the generated text back and finding `bind` had lost its own value — not assumed safe from the
      // `call` case above, which never puts a `bind` inside another head's own parens.
      if (headName === 'make' && node.nodes.length >= 2) {
        const formNode = node.nodes[1]!
        const formName = formNode.kind === 'group' ? printNode(formNode.nodes[0]!, depth) : printNode(formNode, depth)
        const formArgs = formNode.kind === 'group' ? formNode.nodes.slice(1) : []
        const allArgs = [...formArgs, ...node.nodes.slice(2)]

        if (allArgs.length === 0) {
          return `make ${formName}`
        }

        const bindLines = allArgs.map(arg => printBind(arg, depth + 1))

        return `make ${formName}\n${bindLines.join('\n')}`
      }

      // `code <n>` and `text <...>` are literal PREFIXES, not calls: their single child (an integer/decimal/
      // radix node, or a text node) already carries the whole value, so print it directly rather than
      // recursing through `printNode` on the child (which would print the child's OWN full `code <n>`/
      // `text <...>` form and double the prefix — `code(code 16)` — the bug this special case exists to avoid).
      if ((headName === 'code' || headName === 'text') && node.nodes.length === 2) {
        const literal = node.nodes[1]!

        if (literal.kind === 'integer' || literal.kind === 'decimal' || literal.kind === 'radix') {
          return `code ${literal.value}`
        }

        if (literal.kind === 'text') {
          return `text <${textOf(literal)}>`
        }
      }

      // `call` is special-cased on purpose: real Term treats `call f, a, b`, `call f(a, b)`, and the stacked
      // indented form as ONE meaning ("callee f, arguments [a, b]"), merging the callee's own nested children
      // with any further call-level siblings into a single flat argument list (CLAUDE.md's comma-chain rule:
      // "call f(a, b) and call f, a, b and the stacked form are one call"). A naive "head(rest...)" print here
      // would mangle this — found the hard way: it printed a two-argument `call(add, ...)` from a
      // one-argument-to-`add` expression, discovered debugging the very first generated file this compiler
      // produced, not assumed safe going in.
      if (headName === 'call' && node.nodes.length >= 2) {
        const calleeNode = node.nodes[1]!
        const calleeName = calleeNode.kind === 'group' ? printNode(calleeNode.nodes[0]!) : printNode(calleeNode)
        const calleeArgs = calleeNode.kind === 'group' ? calleeNode.nodes.slice(1) : []
        const allArgs = [...calleeArgs, ...node.nodes.slice(2)]

        return allArgs.length === 0 ? `call ${calleeName}` : `call ${calleeName}(${allArgs.map(printNode).join(', ')})`
      }

      const headText = printNode(head)
      const rest = node.nodes.slice(1)

      if (rest.length === 0) {
        return headText
      }

      // ALWAYS parenthesized, never space-separated. A comma pops exactly one level, so a space-nested argument
      // that is followed by a comma swallows what comes next: `call f(read x, code 0)` reads `code 0` as a child
      // of `read`, and `f` gets one argument. `read(x)` closes its own group, so the comma after it lands where
      // it should. See note/term/tree-syntax-vs-term-keywords.md.
      return `${headText}(${rest.map(printNode).join(', ')})`
    }
    default:
      return ''
  }
}

// prints one `bind key, value` line of a `make` at the given depth. Only `printNode`'s `make` case calls this;
// a bind's own value is assumed to be a simple single-line expression here (this package's `mine value`
// expressions never nest a `make` inside a `bind`'s value, so the multi-line case doesn't need handling yet —
// if a future dialect does, this is the one place to extend, not a silent wrong answer).
function printBind(node: Node, depth: number): string {
  const p = '  '.repeat(depth)

  if (node.kind !== 'group' || wordOf(node.nodes[0]) !== 'bind') {
    return `${p}${printNode(node, depth)}`
  }

  const keyNode = node.nodes[1]
  const keyName = keyNode ? (keyNode.kind === 'group' ? printNode(keyNode.nodes[0]!, depth) : printNode(keyNode, depth)) : ''
  const valueNode = node.nodes[2]

  return valueNode ? `${p}bind ${keyName}, ${printNode(valueNode, depth)}` : `${p}bind ${keyName}`
}

// ---- compiling a mine grammar to .tree source text ----

// the two cursor substrates every dialect in this package reads against (`02-cursor.md`): a byte cursor
// (`feed-cursor`) for genuinely binary formats (gzip, OTF), a text cursor (`text-cursor`) for ones whose input
// arrives as characters (hex, JSON, PDF). One compiler, one rule vocabulary, a different primitive-name table
// per substrate — nothing about the RULE READING above depends on which; only code generation does.
export type Substrate = 'byte' | 'text'

interface Ops {
  cursorType: string
  peek: string // -> the raw byte/char at the cursor, cursor unchanged
  peekCode: string // -> the raw byte/char's numeric value (for a byte cursor this is the same as `peek`)
  advance: string // -> the raw byte/char, cursor advances by one
  atEnd: string
  remaining: string
  imports: string[]
}

const OPS: Record<Substrate, Ops> = {
  text: {
    cursorType: 'text-cursor',
    peek: 'text-cursor-peek',
    peekCode: 'text-cursor-peek-code',
    advance: 'text-cursor-read',
    atEnd: 'text-cursor-at-end',
    remaining: '',
    imports: [
      'find text-cursor',
      'find make-text-cursor',
      'find text-cursor-at-end',
      'find text-cursor-peek',
      'find text-cursor-peek-code',
      'find text-cursor-read',
    ],
  },
  byte: {
    cursorType: 'feed-cursor',
    peek: 'peek-byte',
    peekCode: 'peek-byte',
    advance: 'read-byte',
    atEnd: 'at-end',
    remaining: 'remaining',
    imports: [
      'find feed-cursor',
      'find make-cursor',
      'find at-end',
      'find peek-byte',
      'find read-byte',
      'find read-bytes',
      'find read-int',
      'find remaining',
      'find byte-order',
      'find integer-sign',
    ],
  },
}

export function compileFeedMine(
  grammar: FeedMineGrammar,
  substrate: Substrate,
  cursorImportPath: string,
  extraImports: string[] = [],
): string {
  const ops = OPS[substrate]
  const lines: string[] = []

  lines.push(`load ${cursorImportPath}`)

  for (const line of ops.imports) {
    lines.push(`  ${line}`)
  }

  lines.push('')
  lines.push('load @term/seed/code/list')
  lines.push('  find push')
  // `join` is what a text-substrate `mine until` folds its collected characters back into one value with. It
  // used to be emitted without being imported, so a text dialect with an `until` rule generated a file that did
  // not resolve — invisible while only gzip (a byte dialect) exercised that rule.
  lines.push('  find join')
  lines.push('')
  lines.push('load @term/seed/code/boolean')
  lines.push('  find and')
  lines.push('  find not')
  lines.push('')

  for (const line of extraImports) {
    lines.push(line)
  }

  let helperCounter = 0
  const helpers: string[] = []

  for (const [name, rules] of grammar) {
    helperCounter = 0
    const ruleLines: string[] = []

    compileNamedRule(name, rules, ops, grammar, () => `${name}-helper-${helperCounter++}`, ruleLines, helpers)
    lines.push(...ruleLines)
    lines.push('')
  }

  return [...helpers, '', ...lines].join('\n')
}

// ---- types ----
//
// Every generated task needs a declared return type, and every capture a declared one wherever it crosses a task
// boundary. Both come from ONE place: what the rule that produced the value actually reads. This used to be
// three separate hardcoded guesses (`like list / like number` for a list rule, `like text` for `mine any`, `like
// number` for everything else), each right only for the one dialect it was written against — hex's list happens
// to hold numbers and hex is text, so both wrong answers looked correct. Deriving them instead means a byte
// dialect's list gets `like u8` and a `mine form` capture gets the nested rule's own type, without a table.

const BYTE_BLOCK = ['like list', '  like u8']

// the type of the value ONE rule captures.
function captureTypeOf(rule: FeedMineRule, ops: Ops, grammar: FeedMineGrammar, seen: Set<string>): string[] {
  const text = ops.cursorType === 'text-cursor'

  switch (rule.kind) {
    case 'form':
      return returnTypeOf(rule.name, ops, grammar, seen)
    case 'any':
      return text ? ['like text'] : ['like u8']
    case 'byte':
      return ['like u8']
    case 'bytes':
      return BYTE_BLOCK
    case 'until':
      return text ? ['like text'] : BYTE_BLOCK
    // the payload stays `like unknown` (see compileMaybeHelper for why), so the maybe itself is a maybe of it.
    case 'maybe':
      return ['like maybe', '  like unknown']
    case 'int':
    case 'let':
      return ['like number']
    default:
      return ['like number']
  }
}

// the rules of a sequence that actually bind a local, in order.
function capturingRules(rules: FeedMineRule[]): FeedMineRule[] {
  return rules.filter(r => r.kind !== 'value' && r.kind !== 'send' && r.kind !== 'range' && r.kind !== 'list')
}

// a named rule's declared return type. `seen` breaks a grammar that refers to itself (a recursive rule, which
// nothing here has yet but a JSON value would): a cycle falls back to `like unknown` rather than recursing
// forever, which is the honest answer for a type this pass cannot close over.
function returnTypeOf(name: string, ops: Ops, grammar: FeedMineGrammar, seen: Set<string> = new Set()): string[] {
  if (seen.has(name)) {
    return ['like unknown']
  }

  const rules = grammar.get(name)

  if (!rules) {
    return ['like number']
  }

  const inner = new Set(seen)

  inner.add(name)

  if (rules.length === 1 && rules[0]!.kind === 'list') {
    const children = capturingRules((rules[0] as { children: FeedMineRule[] }).children)
    const last = children[children.length - 1]
    const element = last ? captureTypeOf(last, ops, grammar, inner) : ['like number']

    return ['like list', ...element.map(line => `  ${line}`)]
  }

  return inferReturnType(rules, ops, grammar, inner)
}

// a non-list rule's return type: the `mine value` expression's own shape when there is one, otherwise the last
// capture, which is what `compileNamedRule` sends back in that case.
function inferReturnType(rules: FeedMineRule[], ops: Ops, grammar: FeedMineGrammar, seen: Set<string>): string[] {
  const valueRule = rules.find((r): r is { kind: 'value'; expr: GroupNode } => r.kind === 'value')
  const valueExpr = valueRule?.expr

  if (valueExpr && wordOf(valueExpr.nodes[0]) === 'make') {
    const formNode = valueExpr.nodes[1]
    const formName = formNode?.kind === 'group' ? wordOf(formNode.nodes[0]) : wordOf(formNode)

    if (formName) {
      return [`like ${formName}`]
    }
  }

  // a bare `read <name>` value is exactly the named capture, so it carries that capture's own type through
  // (`extra-field`'s `read data`, where `data` came from a `mine bytes`: a byte block, not a number).
  if (valueExpr && wordOf(valueExpr.nodes[0]) === 'read' && valueExpr.nodes.length === 2) {
    const capturedName = wordOf(valueExpr.nodes[1])
    const source = rules.find(r => 'send' in r && (r as { send?: string }).send === capturedName)

    if (source) {
      return captureTypeOf(source, ops, grammar, seen)
    }
  }

  if (valueExpr) {
    return ['like number']
  }

  const captures = capturingRules(rules)
  const last = captures[captures.length - 1]

  return last ? captureTypeOf(last, ops, grammar, seen) : ['like number']
}

// a rule whose ENTIRE body is one `mine list` returns the list of its own repeated match directly (`hex`'s own
// shape: a list of hex-byte, nothing else). Every other rule runs its children as an ordinary sequence,
// collecting `send`-named captures as locals, then returns the `mine value` expression (or, with no explicit
// value, the last capture — a rule that only ever captures one thing needs no combination step).
function compileNamedRule(
  name: string,
  rules: FeedMineRule[],
  ops: Ops,
  grammar: FeedMineGrammar,
  nextHelperName: () => string,
  out: string[],
  helpers: string[],
): void {
  const taskName = `read-${name}`
  const scope: Scope = { sends: [], types: new Map() }

  if (rules.length === 1 && rules[0]!.kind === 'list') {
    const inner = rules[0] as { kind: 'list'; children: FeedMineRule[] }

    out.push(`task ${taskName}`, `  take cursor, like ${ops.cursorType}`)
    out.push(...returnTypeOf(name, ops, grammar).map(line => `  ${line}`))
    out.push('  save result', '    make list', '  walk test', '    hook test')
    out.push(`      call not, call ${ops.atEnd}(read(cursor))`)
    out.push('    hook hold')

    compileSequence(inner.children, 3, ops, grammar, scope, nextHelperName, out, helpers)

    const captured = scope.sends[scope.sends.length - 1] ?? 'item'

    out.push(`      call push(read(result), read(${captured}))`)
    out.push('  send back, read result')

    return
  }

  const body: string[] = []
  let valueExpr: GroupNode | undefined

  for (const rule of rules) {
    if (rule.kind === 'value') {
      valueExpr = rule.expr
      continue
    }

    compileExpr(rule, 1, ops, grammar, scope, nextHelperName, body, helpers)
  }

  out.push(`task ${taskName}`, `  take cursor, like ${ops.cursorType}`)
  out.push(...returnTypeOf(name, ops, grammar).map(line => `  ${line}`))
  out.push(...body)

  if (valueExpr) {
    out.push('  send back')
    out.push(`    ${printNode(valueExpr, 2)}`)
  } else if (scope.sends.length > 0) {
    out.push(`  send back, read ${scope.sends[scope.sends.length - 1]}`)
  }
}

// the locals a sequence has bound so far, in order, with the type each one holds. `sends` alone used to be
// enough, back when every capture that crossed a task boundary was assumed to be a number; a `mine maybe`'s test
// expression reads enclosing locals as real parameters (see `freeReads`), and those need declared types that
// match what the capture actually is.
interface Scope {
  sends: string[]
  types: Map<string, string[]>
}

function bindCapture(scope: Scope, name: string, rule: FeedMineRule, ops: Ops, grammar: FeedMineGrammar): void {
  scope.sends.push(name)
  scope.types.set(name, captureTypeOf(rule, ops, grammar, new Set()))
}

function compileSequence(
  rules: FeedMineRule[],
  indent: number,
  ops: Ops,
  grammar: FeedMineGrammar,
  scope: Scope,
  nextHelperName: () => string,
  out: string[],
  helpers: string[],
): void {
  for (const rule of rules) {
    compileExpr(rule, indent, ops, grammar, scope, nextHelperName, out, helpers)
  }
}

function pad(indent: number): string {
  return '  '.repeat(indent)
}

function compileExpr(
  rule: FeedMineRule,
  indent: number,
  ops: Ops,
  grammar: FeedMineGrammar,
  scope: Scope,
  nextHelperName: () => string,
  out: string[],
  helpers: string[],
): void {
  const p = pad(indent)
  const sends = scope.sends

  switch (rule.kind) {
    case 'form': {
      const localName = rule.send ?? `match-${sends.length}`

      bindCapture(scope, localName, rule, ops, grammar)
      out.push(`${p}save ${localName}`, `${p}  call read-${rule.name}(read(cursor))`)

      return
    }

    case 'any': {
      const helperName = nextHelperName()

      helpers.push(...compileAnyHelper(helperName, rule.children, ops))

      const localName = rule.send ?? `char-${sends.length}`

      bindCapture(scope, localName, rule, ops, grammar)
      out.push(`${p}save ${localName}`, `${p}  call ${helperName}(read(cursor))`)

      return
    }

    case 'byte': {
      const localName = rule.send ?? `byte-${sends.length}`

      bindCapture(scope, localName, rule, ops, grammar)

      if (rule.literal === undefined) {
        out.push(`${p}save ${localName}`, `${p}  call ${ops.advance}(read(cursor))`)

        return
      }

      // a byte with a literal to match against enforces it directly, in flat code (no fork needed for a single
      // fixed value): read it, halt if it isn't what the format requires.
      out.push(`${p}fork test`)
      out.push(`${p}  hook test`)
      out.push(`${p}    call not, call is-equal(call ${ops.peekCode}(read(cursor)), code ${rule.literal})`)
      out.push(`${p}  hook hold`)
      out.push(`${p}    halt <expected byte ${rule.literal}>`)
      out.push(`${p}save ${localName}`)
      out.push(`${p}  call ${ops.advance}(read(cursor))`)

      return
    }

    case 'int': {
      const localName = rule.send ?? `int-${sends.length}`

      bindCapture(scope, localName, rule, ops, grammar)
      out.push(`${p}save ${localName}`)
      out.push(`${p}  call read-int(read(cursor), code ${rule.width}, make(${rule.order}), make(${rule.sign}))`)

      return
    }

    case 'bytes': {
      const localName = rule.send ?? `bytes-${sends.length}`

      bindCapture(scope, localName, rule, ops, grammar)
      out.push(`${p}save ${localName}`)
      out.push(`${p}  call read-bytes(read(cursor), ${printNode(rule.width)})`)

      return
    }

    case 'until': {
      const localName = rule.send ?? `until-${sends.length}`
      const helperName = nextHelperName()

      helpers.push(...compileUntilHelper(helperName, rule.terminator, ops))
      bindCapture(scope, localName, rule, ops, grammar)
      out.push(`${p}save ${localName}`, `${p}  call ${helperName}(read(cursor))`)

      return
    }

    case 'maybe': {
      const localName = rule.send ?? `maybe-${sends.length}`
      const helperName = nextHelperName()
      const built = compileMaybeHelper(helperName, rule, ops, grammar, scope, nextHelperName)

      helpers.push(...built.lines)
      bindCapture(scope, localName, rule, ops, grammar)

      const args = ['read(cursor)', ...built.params.map(name => `read(${name})`)].join(', ')

      out.push(`${p}save ${localName}`, `${p}  call ${helperName}(${args})`)

      return
    }

    case 'let':
      bindCapture(scope, rule.name, rule, ops, grammar)
      out.push(`${p}save ${rule.name}`)
      out.push(`${p}  ${printNode(rule.expr)}`)

      return

    case 'send':
      sends.push(rule.name)

      return

    case 'range':
    case 'list':
    case 'value':
      return
  }
}

// `mine any` over a run of `mine range` alternatives becomes its own helper task: one `fork test` with one
// `hook test`/`hook hold` pair per range, each `hook hold` returning the matched character directly via `send
// back` (never a `save` a caller would need to read after the fork closes — see this file's own header).
function compileAnyHelper(name: string, branches: FeedMineRule[], ops: Ops): string[] {
  const ranges = branches.filter((b): b is { kind: 'range'; base: string; head: string } => b.kind === 'range')
  const element = ops.cursorType === 'text-cursor' ? 'like text' : 'like u8'
  // one peek, held in a local, rather than one per COMPARISON. Each `peek` walks the cursor's cell indirection
  // and its refill check, and the branch chain used it twice per alternative, so matching a character against
  // the last of three ranges peeked six times to read one byte that never moved. Hoisting it is safe precisely
  // because a peek does not advance: every comparison was reading the identical value already.
  const lines: string[] = [
    `task ${name}`,
    `  take cursor, like ${ops.cursorType}`,
    `  ${element}`,
    '  save code',
    `    call ${ops.peekCode}(read(cursor))`,
  ]

  ranges.forEach((branch, i) => {
    const baseCode = branch.base.codePointAt(0) ?? 0
    const headCode = branch.head.codePointAt(0) ?? 0

    if (i === 0) {
      lines.push('  fork test')
    }

    lines.push('    hook test')
    lines.push('      call and')
    lines.push(`        call is-minimum(read(code), code ${baseCode})`)
    lines.push(`        call is-maximum(read(code), code ${headCode})`)
    lines.push('    hook hold')
    lines.push('      send back')
    lines.push(`        call ${ops.advance}(read(cursor))`)
  })

  lines.push(`  halt <expected a match for ${name}>`)

  return lines
}

// `mine until / mine byte, code <n>`: consumes and discards characters/bytes up to (not including) the
// terminator, then consumes the terminator itself and returns what came before it, joined — the NUL-terminated
// string shape gzip's own name/comment fields use. Text and byte substrates differ here (a byte cursor's
// `read-bytes`-style accumulation vs. text's own list-of-characters join), so this is substrate-aware, unlike
// `compileAnyHelper`.
// Both substrates stop on END OF INPUT as well as on the terminator. Without that guard a truncated file (a
// gzip member cut off inside its own name field, say) peeked past the end forever: the peek returns whatever a
// backend gives for an out-of-range index, which is not the terminator, so the loop never met its only exit
// condition. Reading a damaged file has to fail, not hang. The terminator is then consumed only if one is
// actually there, so the cursor never advances past the end either.
function compileUntilHelper(name: string, terminator: number, ops: Ops): string[] {
  const lines: string[] = [`task ${name}`, `  take cursor, like ${ops.cursorType}`]
  const text = ops.cursorType === 'text-cursor'

  lines.push(...(text ? ['  like text'] : ['  like list', '    like u8']))
  lines.push('  save result')
  lines.push('    make list')
  lines.push('  walk test')
  lines.push('    hook test')
  lines.push('      call and')
  lines.push(`        call not, call ${ops.atEnd}(read(cursor))`)
  lines.push(`        call not, call is-equal(call ${ops.peekCode}(read(cursor)), code ${terminator})`)
  lines.push('    hook hold')
  lines.push(`      call push(read(result), call ${ops.advance}(read(cursor)))`)
  lines.push('  fork test')
  lines.push('    hook test')
  lines.push(`      call not, call ${ops.atEnd}(read(cursor))`)
  lines.push('    hook hold')
  lines.push(`      call ${ops.advance}(read(cursor))`)

  if (text) {
    lines.push('  send back')
    lines.push('    call join(read(result), text <>)')

    return lines
  }

  lines.push('  send back, read result')

  return lines
}

// every `read <name>` (other than `read cursor`, always in scope) a Term expression fragment references —
// `mine maybe`'s `test` is compiled into its OWN separate helper task, which has no access to the enclosing
// rule's locals the way inline code would; whatever it reads from outside itself (gzip's `test / call
// bitwise-and(read flags, code 4)` needs the enclosing rule's own `flags` capture) has to come in as an ordinary
// parameter instead. Found this the hard way: `flags is not defined` at runtime inside the generated helper,
// not a type error `term make` itself would catch, since a hand-written `.tree` file would never make this
// mistake — only a code GENERATOR unaware of task-scoping can produce it.
function freeReads(node: Node, out: Set<string> = new Set()): Set<string> {
  if (node.kind === 'group') {
    if (wordOf(node.nodes[0]) === 'read' && node.nodes.length === 2) {
      const name = wordOf(node.nodes[1])

      if (name && name !== 'cursor') {
        out.add(name)
      }
    }

    for (const child of node.nodes) {
      freeReads(child, out)
    }
  }

  return out
}

// `mine maybe / test <expr> / <body> / send <name>`: a real `maybe` (this package's own `@term/seed/code/maybe`
// tagged union, matching every dialect's hand-written reader), gated by the embedded boolean `test` expression.
// `some`'s payload is the body's own last capture, or the `mine value` expression if the body has one.
function compileMaybeHelper(
  name: string,
  rule: { test: GroupNode; children: FeedMineRule[] },
  ops: Ops,
  grammar: FeedMineGrammar,
  outer: Scope,
  nextHelperName: () => string,
): { lines: string[]; params: string[] } {
  const helpers: string[] = []
  const body: string[] = []
  const scope: Scope = { sends: [], types: new Map() }
  let valueExpr: GroupNode | undefined

  for (const child of rule.children) {
    if (child.kind === 'value') {
      valueExpr = child.expr
      continue
    }

    compileExpr(child, 3, ops, grammar, scope, nextHelperName, body, helpers)
  }

  const payload = valueExpr ? printNode(valueExpr) : `read ${scope.sends[scope.sends.length - 1] ?? 'result'}`
  // only the names the test expression reads from OUTSIDE this helper, and each declared as the type the
  // enclosing rule's own capture holds — not `like number` for all of them, which was right only because gzip's
  // four gate tests happen to read one byte-valued `flags` field.
  const params = [...freeReads(rule.test)].filter(p => outer.types.has(p))
  const lines: string[] = [
    ...helpers,
    `task ${name}`,
    `  take cursor, like ${ops.cursorType}`,
    ...params.flatMap(p => {
      const [first, ...rest] = outer.types.get(p) ?? ['like number']

      return [`  take ${p}, ${first}`, ...rest.map(line => `  ${line}`)]
    }),
    '  like maybe',
    // `like unknown`, not a specific inferred type: this maybe's payload could be a number (an int field), text
    // (an `until`-terminated string), or a list (a `bytes` field/nested `form`'s own return) — fully inferring
    // that here would mean threading every named rule's own already-computed return type all the way into this
    // helper, which nothing else in this compiler needs to do yet. `like unknown` is documented as consistent
    // with every concrete type in both directions, so it unifies correctly wherever a caller (gzip-file's own
    // `like maybe, like text` field, say) actually uses the value — narrower inference is real future work, not
    // a correctness gap today.
    '    like unknown',
    '  fork test',
    '    hook test',
    `      call is-above(${printNode(rule.test)}, code 0)`,
    '    hook hold',
    ...body,
    '      send back',
    '        make some',
    `          bind value, ${payload}`,
    '  send back',
    '    make none',
  ]

  return { lines, params }
}
