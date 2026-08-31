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
import { readGroups } from '@term/make/code/parser/stream'
import { headWord, textOf, wordOf } from './mill-run'

// ---- reading the mine grammar into rule objects ----

export type FeedMineRule =
  // `mine list` with an optional `bind count, read table-count`: a repetition, COUNT-DIRECTED when it says how
  // many. Without the count it reads until the input ends, which is right for a whole file and wrong for a table
  // that declares its own length.
  | { kind: 'list'; children: FeedMineRule[]; count?: Node }
  | { kind: 'any'; children: FeedMineRule[]; send?: string }
  | { kind: 'range'; base: string; head: string }
  // `mine form, form row` with `bind separator, share separator` children: a reference to another rule, with the
  // ARGUMENTS that rule's own `start` parameters receive. csv threads its separator down five rules this way.
  | { kind: 'form'; name: string; send?: string; args?: FeedMineArg[] }
  | { kind: 'value'; expr: GroupNode }
  | { kind: 'send'; name: string }
  | { kind: 'byte'; literal?: number; send?: string }
  // `mine char, text <">` / `mine char, code 0x0020`: exactly one character, by literal or by code point. The
  // text-substrate twin of `byte`, and JSON's most-used construct (31 of its 9 kinds).
  | { kind: 'char'; literal: number; send?: string }
  // `mine text, text <true>`: a fixed multi-character literal, matched in order
  | { kind: 'text'; literal: string; send?: string }
  // `mine not / mine any / mine char ...`: negative lookahead. The next character must not be one of these, and
  // nothing is consumed either way. JSON's `safe-char` is this plus a range: any character in the range that is
  // not a quote or a backslash.
  | { kind: 'not'; codes: number[] }
  // `mine mark / bind width, code 4 / mine form, form hex-digit`: the nested rule exactly `width` times, which is
  // how a `\uXXXX` escape says four hex digits
  | { kind: 'mark'; width: number; children: FeedMineRule[]; send?: string }
  | { kind: 'int'; width: number; order: 'big' | 'little'; sign: 'signed' | 'unsigned'; send?: string }
  | { kind: 'bytes'; width: GroupNode; send?: string }
  | { kind: 'maybe'; test?: GroupNode; children: FeedMineRule[]; send?: string }
  | { kind: 'until'; terminator: number; send?: string }
  | { kind: 'let'; name: string; expr: GroupNode }
  // `bind value / mine text / <rules>`: a SPAN CAPTURE. The value is the text its children consumed, which is how
  // JSON's `number` says "whatever these rules matched, as written". It ACCUMULATES what each read returns rather
  // than slicing the cursor: text-cursor-compact discards consumed text past 64 KiB and resets the position, so a
  // start offset is not a thing a streaming cursor can be asked to remember.
  | { kind: 'span'; children: FeedMineRule[]; send: string }
  // `start separator, share <,>`: a rule PARAMETER, with an optional default. A rule is not always readable from
  // the cursor alone: csv's every rule needs the separator, png's chunk needs its length, and OTF's value-record
  // is read against a value-format its caller holds. It is the same need `mine at` has for an offset.
  //
  // It sits in the rules array rather than in a separate table because that is how `value` already works: the
  // named-rule compiler pulls both out before walking the body, and every consumer that counts rules keeps
  // counting the same way.
  | { kind: 'start'; name: string; fall?: Node }
  // `check bitwise-and / bind start, share value-format / bind front, share 0x0001 / <body>`: a read gated on a
  // condition. This is `mine maybe` with an explicit `test` written in another notation, and it compiles to
  // exactly that: gzip already spells this shape as a maybe, because a flag bit read earlier is a condition no
  // lookahead can know. 32 uses across 8 grammars, all of them OTF tables and ELF.
  | { kind: 'check'; op: string; base: Node; head: Node; children: FeedMineRule[]; send?: string }

// an argument at a call: `bind separator, share separator`
export type FeedMineArg = { name: string; value: Node }

export type FeedMineGrammar = Map<string, FeedMineRule[]>

// a standalone `send <name>` that follows a value-producing rule renames THAT rule's own capture — it never
// introduces a second, disconnected local (`mine form` already carries its own nested `send` from
// `readFeedMineRule`'s `form` case; this is for every OTHER kind, where `send` is a trailing sibling instead).
// Runs once over every rules array as it's built, so a compiler pass never has to guess which capture a trailing
// `send` belongs to.
// every word that names a CONSTRUCT rather than a rule. A `mine <word>` outside this set is a reference to another
// rule by name, which is the short spelling of `mine form, form <word>`.
const CONSTRUCTS = new Set([
  'list', 'any', 'range', 'form', 'value', 'byte', 'char', 'text', 'not',
  'mark', 'int', 'bytes', 'maybe', 'until', 'let', 'send', 'at',
])

const SENDABLE = new Set(['any', 'byte', 'char', 'text', 'mark', 'int', 'bytes', 'until', 'form', 'maybe'])

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
// the value of a `bind <name>, <value>`, WHATEVER SHAPE it is. It used to return only a group, so a bare literal
// (`bind base, <0>`, which is how most of @term/feed's grammars write a range bound) was discarded and the rule
// that needed it read as nothing.
function bindValueGroup(group: GroupNode, name: string): Node | undefined {
  for (const child of group.nodes) {
    if (child.kind === 'group' && headWord(child) === 'bind' && wordOf(child.nodes[1]) === name) {
      return child.nodes[2]
    }
  }

  return undefined
}

// `bindValueGroup` gets the raw `<value>` group; these three unwrap it for the three literal shapes a `bind`
// actually carries in this package: `text <...>`, `code <n>`, and `term <word>` (an enum-case reference, e.g.
// `bind order, term little`).
// `bind base, text <0>` and `bind base, <0>` are the same binding. The second is how most of @term/feed's grammars
// write a range bound, and reading only the first dropped every one of them: latin, latin/number and ipv4 all lost
// their character classes to it.
function bindTextOf(group: GroupNode, name: string): string | undefined {
  const value = bindValueGroup(group, name)

  if (value?.kind === 'text') {
    return textOf(value)
  }

  const inner = value?.kind === 'group' && headWord(value) === 'text' ? value.nodes[1] : undefined
  const written = inner ? textOf(inner) : undefined

  // An EMPTY result is no result. `bind base, text 0` has a `text` head and a NUMBER under it, so textOf gives ''
  // — and `''` is neither null nor undefined, so a `bindTextOf(...) ?? bindCodeOf(...)` chain stopped there and the
  // rule read as a range from '' to ''. ascii/mine.tree is written exactly that way.
  return written === undefined || written === '' ? undefined : written
}

// `bind base, code 0` and `bind base, 0` are the same binding, the second being how ipv4 writes its octet range.
function bindCodeOf(group: GroupNode, name: string): number | undefined {
  const value = bindValueGroup(group, name)

  if (value?.kind === 'integer' || value?.kind === 'decimal' || value?.kind === 'radix') {
    return value.value
  }

  // `bind base, text 0`, which is how ascii/mine.tree writes its range: the head says `text` and the argument is
  // a NUMBER, so it is a code point wearing the other keyword.
  if (value?.kind === 'group' && headWord(value) === 'text') {
    const written = value.nodes[1]

    if (written?.kind === 'integer' || written?.kind === 'decimal' || written?.kind === 'radix') {
      return written.value
    }
  }

  // `bind base, share 0`, which is how bit/mine.tree writes its octet range
  if (value?.kind === 'group' && headWord(value) === 'share') {
    const shared = value.nodes[1]

    if (shared?.kind === 'integer' || shared?.kind === 'decimal' || shared?.kind === 'radix') {
      return shared.value
    }
  }

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

// `share <thing>`: how a grammar names a VALUE, wherever one is passed rather than read from the cursor — a
// `start` default, a `check` operand, an argument at a call. Rendered to the Term that means it, with the outer
// names it reads reported alongside, because a helper that uses one has to take it as a parameter.
//
// Three shapes, and the grammars use all three: `share separator` is a NAME (a parameter or a capture in scope),
// `share 0x0001` is a number, `share <,>` is text. A bare `0x0001` with no `share` is the same number, because a
// `bind front, 0x0001` is written both ways across these files.
function shareValue(node: Node | undefined): { text: string; reads: string[] } | undefined {
  if (!node) {
    return undefined
  }

  if (node.kind === 'integer' || node.kind === 'decimal' || node.kind === 'radix') {
    return { text: `code ${node.value}`, reads: [] }
  }

  if (node.kind === 'text') {
    return { text: printNode(node), reads: [] }
  }

  if (node.kind !== 'group') {
    return undefined
  }

  // `share <thing>` and `read <thing>` are both WRAPPERS around the value. Unwrap and read what they hold: a
  // grammar writes `bind count, read table-count` and `bind separator, share separator` for the same kind of
  // thing, and taking the group's head word instead of its argument rendered both as `read(read)`.
  const wrapper = headWord(node)

  if (wrapper === 'share' || wrapper === 'read') {
    return shareValue(node.nodes[1])
  }

  const word = wordOf(node)

  // `read(name)`, PARENTHESISED, and that is not a style choice. A rendered operand goes into a comma-separated
  // argument list, and a comma pops exactly one level: `call bitwise-and(read value-format, code 1)` puts the
  // `code 1` INSIDE the `read`, so `bitwise-and` is called with one argument. The parens are a floor the comma
  // cannot cross. This is the trap CLAUDE.md names outright, and it cost eleven check errors before it was.
  return word ? { text: `read(${word})`, reads: [word] } : undefined
}

// the arguments a `mine form` passes: `bind separator, share separator` children
function argsOf(group: GroupNode): FeedMineArg[] {
  const out: FeedMineArg[] = []

  for (const child of siblingsOf(group)) {
    if (child.kind !== 'group' || headWord(child) !== 'bind') {
      continue
    }

    const name = wordOf(child.nodes[1])
    const value = child.nodes[2]

    if (name && value) {
      out.push({ name, value })
    }
  }

  return out
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

  // `bind <name>` wrapping a bare `mine text`: a span capture named <name>. The `take <name>, like <type>` beside
  // it declares the same name and carries no rules of its own, so it is read for nothing here.
  if (head === 'bind') {
    const name = wordOf(group.nodes[1])
    const inner = siblingsOf(group)
      .filter((n): n is GroupNode => n.kind === 'group')
      .find(n => headWord(n) === 'mine' && wordOf(n.nodes[1]) === 'text')

    if (!name) {
      return undefined
    }

    // `bind <name>` around anything OTHER than a bare `mine text` is a plain NAMED CAPTURE: run that rule and call
    // its result <name>, which is what `pair`'s `bind key / mine form, form string` says. Reading only the span
    // shape left `pair` with no captures at all, so it declared `like text` and returned the whitespace list that
    // happened to be last.
    if (!inner) {
      const rules: FeedMineRule[] = []

      for (const child of siblingsOf(group).filter((n): n is GroupNode => n.kind === 'group')) {
        const rule = readFeedMineRule(child)

        if (rule) {
          rules.push(rule)
        }
      }

      const only = rules.length === 1 ? rules[0] : undefined

      return only && 'send' in only ? { ...only, send: name } : only
    }

    const children: FeedMineRule[] = []

    for (const child of siblingsOf(inner).filter((n): n is GroupNode => n.kind === 'group')) {
      const rule = readFeedMineRule(child)

      if (rule) {
        children.push(rule)
      }
    }

    return children.length > 0 ? { kind: 'span', children, send: name } : undefined
  }

  if (head === 'send') {
    const name = wordOf(group.nodes[1])

    return name ? { kind: 'send', name } : undefined
  }

  // `start separator, share <,>`: a rule parameter, with an optional default
  if (head === 'start') {
    const name = wordOf(group.nodes[1])

    return name ? { kind: 'start', name, fall: group.nodes[2] } : undefined
  }

  // `check <op> / bind start, <a> / bind front, <b> / <body>`: a read gated on a condition. The two operands are
  // named `start` and `front` here, the same two names a `range` uses for its bounds.
  if (head === 'check') {
    const op = wordOf(group.nodes[1])
    const kids = siblingsOf(group).filter((n): n is GroupNode => n.kind === 'group')
    const base = kids.find(n => headWord(n) === 'bind' && wordOf(n.nodes[1]) === 'start')?.nodes[2]
    const front = kids.find(n => headWord(n) === 'bind' && wordOf(n.nodes[1]) === 'front')?.nodes[2]

    if (!op || !base || !front) {
      return undefined
    }

    const children: FeedMineRule[] = []

    for (const child of kids) {
      // the two `bind`s are the condition, not the body
      if (headWord(child) === 'bind' && ['start', 'front'].includes(wordOf(child.nodes[1]) ?? '')) {
        continue
      }

      const rule = readFeedMineRule(child)

      if (rule) {
        children.push(rule)
      }
    }

    return children.length > 0
      ? { kind: 'check', op, base, head: front, children }
      : undefined
  }

  // `look after` with `mine form` children is an ALTERNATION, the same construct `mine any` spells. 24 uses across
  // @term/feed (cookie, uri, css, latin), and read as nothing without this.
  if (head === 'look' && wordOf(group.nodes[1]) === 'after') {
    const out: FeedMineRule[] = []

    for (const child of siblingsOf(group).filter((n): n is GroupNode => n.kind === 'group')) {
      const rule = readFeedMineRule(child)

      if (rule) {
        out.push(rule)
      }
    }

    return out.length > 0 ? { kind: 'any', children: out } : undefined
  }

  if (head !== 'mine') {
    return undefined
  }

  // `mine <->`: a bare TEXT LITERAL as the whole body, with no `text` or `char` keyword. It is how a grammar
  // writes a single delimiter, and ipv4's `dot` and latin/number's `minus` are both this.
  const bare = group.nodes[1]

  if (bare?.kind === 'text') {
    const literal = textOf(bare)

    if (literal.length === 1) {
      return { kind: 'char', literal: literal.codePointAt(0)!, send: nestedSend(group) }
    }

    if (literal.length > 1) {
      return { kind: 'text', literal, send: nestedSend(group) }
    }
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
    case 'list': {
      // `bind count, read table-count`: how many to read. OTF's cmap declares its encoding-record count in the
      // two bytes before them, which is the ordinary shape of a binary table.
      const countBind = siblingsOf(group)
        .filter((n): n is GroupNode => n.kind === 'group')
        .find(n => headWord(n) === 'bind' && wordOf(n.nodes[1]) === 'count')

      return { kind: 'list', children: children(), count: countBind?.nodes[2] }
    }

    case 'any':
      return { kind: 'any', children: children() }

    // A bound is written either as the character itself (`bind base, text <0>`) or as its code point
    // (`bind base, code 0x0020`), and a grammar uses whichever reads better: a digit range as digits, a
    // control-character boundary as a number. Reading only the first spelling dropped the whole rule silently, and
    // with it JSON's `safe-char`, which is every character of every string.
    // `base`/`head` and `start`/`end` name the same two bounds. Both spellings are in @term/feed's own grammars.
    case 'range': {
      const baseText = bindTextOf(group, 'base') ?? bindTextOf(group, 'start')
      const headText = bindTextOf(group, 'head') ?? bindTextOf(group, 'end')
      const baseCode = bindCodeOf(group, 'base') ?? bindCodeOf(group, 'start')
      const headCode = bindCodeOf(group, 'head') ?? bindCodeOf(group, 'end')
      const base = baseText ?? (baseCode === undefined ? undefined : String.fromCodePoint(baseCode))
      const head2 = headText ?? (headCode === undefined ? undefined : String.fromCodePoint(headCode))

      return base && head2 ? { kind: 'range', base, head: head2 } : undefined
    }

    case 'form': {
      const formGroup = rawChildren().find(n => headWord(n) === 'form')
      const name = formGroup ? wordOf(formGroup.nodes[1]) : undefined
      const sendGroup = rawChildren().find(n => headWord(n) === 'send')
      const send = sendGroup ? wordOf(sendGroup.nodes[1]) : undefined
      // `bind separator, share separator`: the arguments the referenced rule's own `start` parameters receive
      const args = argsOf(group)

      return name
        ? { kind: 'form', name, send, args: args.length > 0 ? args : undefined }
        : undefined
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

    // `mine char, text <">` or `mine char, code 0x0020`: one character, given either way. The two spellings are the
    // same rule, because a grammar writes a printable delimiter as itself and a control character as its code.
    case 'char': {
      const textGroup = rawChildren().find(n => headWord(n) === 'text')
      const codeGroup = rawChildren().find(n => headWord(n) === 'code')
      const writtenNode = textGroup?.nodes[1]
      const written = writtenNode ? textOf(writtenNode) : undefined
      const literal =
        written !== undefined
          ? written.codePointAt(0)
          : codeGroup
            ? codeValueOf(codeGroup)
            : undefined

      return literal === undefined
        ? undefined
        : { kind: 'char', literal, send: nestedSend(group) }
    }

    // `mine not`: the codes the next character must not be. Its alternatives read like any other rule's, so this
    // reuses `children()` and then flattens: a lookahead is written either as one `char` or as an `any` of them.
    case 'not': {
      const codes: number[] = []

      const gather = (rules: FeedMineRule[]): void => {
        for (const rule of rules) {
          if (rule.kind === 'char') {
            codes.push(rule.literal)
          } else if (rule.kind === 'any' || rule.kind === 'list') {
            gather(rule.children)
          }
        }
      }

      gather(children())

      return codes.length > 0 ? { kind: 'not', codes } : undefined
    }

    // `mine mark, bind width, code 4`: the nested rules exactly `width` times
    case 'mark': {
      const width = bindCodeOf(group, 'width')
      const children = rawChildren()
        .filter(n => headWord(n) !== 'bind')
        .map(readFeedMineRule)
        .filter((r): r is FeedMineRule => r !== undefined)

      return width === undefined || children.length === 0
        ? undefined
        : { kind: 'mark', width, children, send: nestedSend(group) }
    }

    // `mine text, text <true>`: a fixed multi-character literal.
    //
    // `mine text 13` is the same construct with the literal written as a CODE POINT, which is how a grammar spells
    // a control character it cannot type: @term/feed's latin/whitespace says `mine text 13` for a carriage return.
    // Read only as a text literal, those rules were dropped and the whole whitespace grammar lost half its rules.
    case 'text': {
      // `mine text 13` nests the code INSIDE the kind group (`mine > text > 13`), not beside it, because a space
      // nests: the `13` is a child of `text`. Reading it off the `mine` group finds the `text` group itself.
      const kindGroup = group.nodes[1]
      const inlineCode =
        kindGroup?.kind === 'group' ? codeValueOf(kindGroup) : undefined

      if (inlineCode !== undefined) {
        return { kind: 'char', literal: inlineCode, send: nestedSend(group) }
      }

      const textGroup = rawChildren().find(n => headWord(n) === 'text')
      const literalNode = textGroup?.nodes[1]
      const literal = literalNode ? textOf(literalNode) : undefined

      return literal === undefined || literal.length === 0
        ? undefined
        : { kind: 'text', literal, send: nestedSend(group) }
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

      // a width is an EXPRESSION and so is always a group; a bare literal there would not be one to evaluate
      return width?.kind === 'group'
        ? { kind: 'bytes', width, send: nestedSend(group) }
        : undefined
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

      // A `maybe` with NO `test` is decided by its own FIRST set: try it if the next character could begin it.
      // gzip writes an explicit test because its condition is a flag bit read earlier, which no lookahead can
      // know; JSON writes a bare `mine maybe` around the rules it makes optional, and the condition IS "does the
      // next character start one of these". Both are the same construct with the condition supplied differently.
      return { kind: 'maybe', test: testExpr, children: mergeSends(bodyRules), send }
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

    // `mine <rule-name>`: a bare reference to another rule, the short spelling of `mine form, form <rule-name>`.
    // A word that is not one of the constructs above can only be a rule name, and grammars use it freely:
    // latin/whitespace's `carriage-return-line-feed` is two of them, and read as nothing without this.
    default:
      return kind && !CONSTRUCTS.has(kind)
        ? { kind: 'form', name: kind, send: nestedSend(group) }
        : undefined
  }
}

// Which substrate a grammar reads: bytes or characters.
//
// It is INFERRED from the constructs the grammar uses rather than declared, because it does not need declaring:
// `byte`, `int` and `bytes` can only read a byte cursor, and `char`, `text`, `range` and `span` can only read a
// text one. Measured across @term/feed's 30 readable grammars on 2026-08-31, SIX are byte-only, EIGHT are
// text-only, and ZERO use both, so there is nothing to disambiguate and no new syntax to add. The remaining
// sixteen use neither: they are pure combinators over rules that are still stubs, and have no leaf to infer from
// yet, which is why this answers undefined rather than guessing.
//
// `term make` needs this to compile a dialect's mine.tree as part of an ordinary build (format-mill-0009): the
// harness passes the substrate in today, and a build has nobody to ask.
export function feedMineSubstrate(
  grammar: FeedMineGrammar,
): Substrate | undefined {
  const BYTE = new Set(['byte', 'int', 'bytes'])
  const TEXT = new Set(['char', 'text', 'range', 'span'])

  let byte = false
  let text = false

  const walk = (rules: readonly FeedMineRule[]): void => {
    for (const rule of rules) {
      if (BYTE.has(rule.kind)) {
        byte = true
      }

      if (TEXT.has(rule.kind)) {
        text = true
      }

      const children = (rule as { children?: FeedMineRule[] }).children

      if (Array.isArray(children)) {
        walk(children)
      }
    }
  }

  for (const rules of grammar.values()) {
    walk(rules)
  }

  // a grammar that somehow used both would be a grammar with a mistake in it, and guessing would hide it
  if (byte === text) {
    return undefined
  }

  return byte ? 'byte' : 'text'
}

// The `load` blocks a grammar writes for itself, as source lines.
//
// A `mine value` is an ORDINARY TERM EXPRESSION over the rule's captures, and it may call a real helper: hex's
// digit rule calls `hex-digit-value`, because turning a character into a number is arithmetic and not something
// to reinvent as grammar syntax. That helper has to be imported, and the only party who knows where it lives is
// the grammar. The test harness used to hand the import in from outside, which is exactly why a grammar could be
// compiled by the harness and by nobody else.
//
// So a grammar writes `load` the way every other `.tree` file does, and the generated reader carries those blocks
// through verbatim. No new syntax: `load` is Term's import statement, parsed here by the same parser.
//
// THE PARSER FINDS THE BOUNDARIES. `readGroups` says where each top-level group ends, and the raw lines of the
// ones headed `load` are taken from the source untouched. Counting indentation to find a block's extent would be
// a second reader of the grammar, which is the thing that must not exist.
export function feedMineLoads(file: string, text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let at = 0

  for (const result of readGroups({ file, text })) {
    if (result.kind !== 'group') {
      break
    }

    const span = lines.slice(at, at + result.lines)

    at += result.lines

    if (headWord(result.group) === 'load') {
      out.push(...span.map(line => line.replace(/\s+$/, '')))
    }
  }

  // a trailing blank so the generated file's own `load` blocks do not run into these
  return out.length > 0 ? [...out, ''] : out
}

// The rules a grammar DECLARES that read to nothing.
//
// `readFeedMineRule` returns undefined for a shape it does not know, and the rule then vanishes from the grammar
// without a word: the reader still generates, still parses, still mills, and is simply missing a rule. Measured
// across the 99 mine.tree grammars in @term/feed on 2026-08-31, 18 of the 30 that generate at all are missing at
// least one, and some are missing every rule they declare.
//
// The rule NAMES a grammar refers to and never defines.
//
// `mine <word>` outside the construct set is the short spelling of `mine form, form <word>`, a reference to
// another rule. That is a real and used feature, so an unknown word cannot simply be refused. But a reference to
// a rule the grammar does NOT DEFINE is wrong under every reading of it, and today it is silent all the way
// down: the grammar reads, the drop count stays at zero (it counts top-level rules that read to NOTHING, and a
// reference is something), the reader generates, and it mills. The first complaint is `read-crown is not
// defined` from the type checker, if anyone ever compiles it.
//
// It is not a small number. A SECOND CONSTRUCT VOCABULARY runs through these grammars that the reader does not
// know — `chunk`, `bound`, `crown`, `chord`, `chain`, `sieve`, `count`, `shard`, `block`, `leave`, `flow`,
// `crest`, `shift`, `binary` — and every use of one lands here. Those words are not in note/term/feed's grammar
// spec, so what each MEANS is an open question and not one this function answers. What it does is stop the
// question being invisible.
export function feedMineUnknownRefs(grammar: FeedMineGrammar): string[] {
  const missing = new Set<string>()

  const walk = (rules: readonly FeedMineRule[]): void => {
    for (const rule of rules) {
      if (rule.kind === 'form' && !grammar.has(rule.name)) {
        missing.add(rule.name)
      }

      const children = (rule as { children?: FeedMineRule[] }).children

      if (Array.isArray(children)) {
        walk(children)
      }
    }
  }

  for (const rules of grammar.values()) {
    walk(rules)
  }

  return [...missing].sort()
}

// This is what makes that visible. A caller that cares (the build, a gate) asks for the drops and refuses; one
// that does not is unaffected, so nothing existing changes behaviour.
export function feedMineDrops(tree: RootNode): string[] {
  const grammar = readFeedMineGrammar(tree)
  const out: string[] = []

  for (const group of tree.nodes) {
    if (headWord(group) !== 'mine') {
      continue
    }

    const name = wordOf(group.nodes[1])

    if (!name || (grammar.get(name) ?? []).length > 0) {
      continue
    }

    // A rule DECLARED WITH NO BODY is a stub in the grammar, not something the reader failed to read: `mine aif`
    // and gdef's `mine version` are a name and nothing else. Counting those as drops would blame the reader for
    // work the grammar has not done, and would make the number impossible to drive to zero from this side.
    if (siblingsOf(group).some(n => n.kind === 'group')) {
      out.push(name)
    }
  }

  return out
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
  // `size` is how a COUNT-DIRECTED list knows how many it has read: the list's own length is the counter, so the
  // loop needs no reassignment
  lines.push('  find size')
  // `join` is what a text-substrate `mine until` folds its collected characters back into one value with. It
  // used to be emitted without being imported, so a text dialect with an `until` rule generated a file that did
  // not resolve — invisible while only gzip (a byte dialect) exercised that rule.
  lines.push('  find join')
  lines.push('')
  // `unwrap-or` is how a SPAN turns an optional part into text: absent means the empty string, which is exactly
  // what "the text these rules consumed" means for a part that matched nothing.
  lines.push('load @term/seed/code/maybe')
  lines.push('  find unwrap-or')
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
    // a matched character comes back as the text it matched, so a rule can send it on
    case 'char':
      return text ? ['like text'] : ['like u8']
    case 'text':
      return ['like text']
    // a lookahead captures nothing: it only refuses
    case 'not':
      return ['like number']
    case 'range':
      return text ? ['like text'] : ['like u8']
    // a span's value is the text it consumed
    case 'span':
      return ['like text']
    case 'mark':
      return ['like list', '  like text']
    case 'bytes':
      return BYTE_BLOCK
    case 'until':
      return text ? ['like text'] : BYTE_BLOCK
    // the payload stays `like unknown` (see compileMaybeHelper for why), so the maybe itself is a maybe of it. A
    // `check` compiles to the same helper and so has the same type: without this it fell to the `like number`
    // default and every rule ending in one declared a number for a maybe.
    case 'check':
    case 'maybe':
      return ['like maybe', '  like unknown']
    // A NESTED LIST is a list of whatever its last child captures. There was no case for it, so a rule ending in
    // one fell to the `like number` default and declared a number for an array: `cmap-table` reads two ints and
    // then a list of encoding records, and `latin/number` does the same. The whole-body form of this is already
    // handled in returnTypeOf; this is the same answer for a list that is one rule among several.
    case 'list': {
      const kids = capturingRules(rule.children)
      const last = kids[kids.length - 1]

      return [
        'like list',
        ...(last ? captureTypeOf(last, ops, grammar, seen) : ['like unknown']).map(line => `  ${line}`),
      ]
    }
    case 'int':
    case 'let':
      return ['like number']
    default:
      return ['like number']
  }
}

// The rules of a sequence that actually bind a local, in order.
//
// `range` IS one now: a range standing alone in a sequence reads a character and saves it, where before it only
// appeared inside an `any` and captured nothing. Leaving it out made `read-digits` declare `like list, like number`
// for a list of characters. `not` is NOT one: a negative lookahead consumes nothing and binds nothing, and counting
// it made `read-safe-char` declare `like number` for a rule that returns a character.
function capturingRules(rules: FeedMineRule[]): FeedMineRule[] {
  return rules.filter(
    r =>
      r.kind !== 'value' &&
      r.kind !== 'send' &&
      r.kind !== 'not' &&
      r.kind !== 'list',
  )
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

  // a `start` is a PARAMETER, not part of the body, so a rule whose body is one list still reads as one here
  const body = rules.filter(r => r.kind !== 'start')

  if (body.length === 1 && body[0]!.kind === 'list') {
    const children = capturingRules((body[0] as { children: FeedMineRule[] }).children)
    const last = children[children.length - 1]
    const element = last ? captureTypeOf(last, ops, grammar, inner) : ['like number']

    return ['like list', ...element.map(line => `  ${line}`)]
  }

  return inferReturnType(body, ops, grammar, inner)
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

  // A NESTED LIST BINDS, so it is a candidate for "the last capture" here even though `capturingRules` leaves it
  // out. That exclusion is right where it is used on a list's own CHILDREN (a list inside a list is not the
  // element type), and wrong here: the emitter pushes the list's local last and sends it back, so a rule that
  // ends in one returns the LIST. Without this `cmap-table` read two ints and a list of encoding records and
  // declared `like number`, and the generated reader could not typecheck.
  const captures = rules.filter(
    r => r.kind === 'list' || capturingRules([r]).length > 0,
  )
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

  // The rule's PARAMETERS, pulled off the front the way `value` is pulled out of the body below. They become
  // `take` lines after the cursor, and they go into the scope's types so a helper nested inside this rule takes
  // them too: `freeReads` already asks the outer scope which names it has to thread through, and a parameter is
  // one of those names.
  //
  // The declared type comes from the DEFAULT when there is one, because that is the only thing in the grammar
  // that says what the value is. Without one it is `like unknown`, the gradual type, which is consistent with
  // every concrete type in both directions and so unifies at whatever the call site actually passes. Guessing
  // `like number` instead would be right for OTF's flags and wrong for csv's separator.
  const starts = rules.filter((r): r is Extract<FeedMineRule, { kind: 'start' }> => r.kind === 'start')
  const takes: string[] = []

  for (const start of starts) {
    const fall = shareValue(start.fall)
    const type = fall?.text.startsWith('text ')
      ? 'like text'
      : fall?.text.startsWith('code ')
        ? 'like number'
        : 'like unknown'

    scope.types.set(start.name, [type])
    takes.push(`  take ${start.name}, ${type}${fall ? `, fall ${fall.text}` : ''}`)
  }

  const body0 = rules.filter(r => r.kind !== 'start')

  if (body0.length === 1 && body0[0]!.kind === 'list') {
    const inner = body0[0] as { kind: 'list'; children: FeedMineRule[] }

    out.push(`task ${taskName}`, `  take cursor, like ${ops.cursorType}`, ...takes)
    out.push(...returnTypeOf(name, ops, grammar).map(line => `  ${line}`))
    out.push('  save result', '    make list', '  walk test', '    hook test')
    out.push(`      call not, call ${ops.atEnd}(read(cursor))`)
    out.push('    hook hold')

    // a whole rule's body that IS a list is a repetition too, so its inner rules end it rather than raising on the
    // first non-match, exactly as a nested `mine list` does. Without this `read-digits` threw
    // `expected a character between 48 and 57` on the first character after the digits, which is every number that
    // is not the entire input.
    inRepetition++
    compileSequence(inner.children, 3, ops, grammar, scope, nextHelperName, out, helpers)
    inRepetition--

    const captured = scope.sends[scope.sends.length - 1] ?? 'item'

    out.push(`      call push(read(result), read(${captured}))`)
    out.push('  send back, read result')

    return
  }

  const body: string[] = []
  let valueExpr: GroupNode | undefined

  for (const rule of body0) {
    if (rule.kind === 'value') {
      valueExpr = rule.expr
      continue
    }

    compileExpr(rule, 1, ops, grammar, scope, nextHelperName, body, helpers)
  }

  out.push(`task ${taskName}`, `  take cursor, like ${ops.cursorType}`, ...takes)
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

// Inside a `mine list`, a rule that does not match ENDS THE REPETITION rather than failing the parse: that is what
// "zero or more" means. Bare `halt` breaks a loop in Term and `halt <text>` raises, so the same guard emits one or
// the other depending on where it sits. Without this a list of digits halted the whole read on the first character
// that was not a digit, which is every list that is not the entire input.
let inRepetition = 0

// Inside a SPAN, every part has to answer with the text it consumed, and that applies to a `maybe` as much as to a
// character. A maybe's payload is otherwise its LAST capture, which drops everything before it: JSON's fractional
// part is `.` then digits, so the payload was the digits and `3.5` read back as `35`. Same for the exponent, whose
// `e` vanished the same way.
let inSpan = 0

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

      // the arguments this rule's `start` parameters receive, as NAMED arguments so the checker puts each in the
      // callee's declared position: the cursor is positional and first, everything else is named.
      const args = (rule.args ?? [])
        .map(arg => ({ name: arg.name, value: shareValue(arg.value) }))
        .filter((a): a is { name: string; value: { text: string; reads: string[] } } => a.value !== undefined)

      if (args.length === 0) {
        out.push(`${p}save ${localName}`, `${p}  call read-${rule.name}(read(cursor))`)

        return
      }

      out.push(`${p}save ${localName}`, `${p}  call read-${rule.name}`, `${p}    read cursor`)

      for (const arg of args) {
        out.push(`${p}    bind ${arg.name}, ${arg.value.text}`)
      }

      return
    }

    case 'any': {
      const helperName = nextHelperName()

      helpers.push(...compileAnyHelper(helperName, rule.children, ops, grammar))

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

    // `mine char, text <">`: read one character and require it. The text-substrate twin of `byte` above, and the
    // same flat shape: a single fixed value needs no fork to choose, only one to refuse.
    case 'char': {
      const localName = rule.send ?? `char-${sends.length}`

      bindCapture(scope, localName, rule, ops, grammar)
      out.push(`${p}fork test`)
      out.push(`${p}  hook test`)
      out.push(`${p}    call not, call is-equal(call ${ops.peekCode}(read(cursor)), code ${rule.literal})`)
      out.push(`${p}  hook hold`)
      out.push(inRepetition > 0 ? `${p}    halt` : `${p}    halt <expected character ${rule.literal}>`)
      out.push(`${p}save ${localName}`)
      out.push(`${p}  call ${ops.advance}(read(cursor))`)

      return
    }

    // `mine text, text <true>`: the same, once per character, so a mismatch halts on the character that differed
    // rather than after the whole literal
    case 'text': {
      const localName = rule.send ?? `text-${sends.length}`

      bindCapture(scope, localName, rule, ops, grammar)

      for (const character of [...rule.literal]) {
        const code = character.codePointAt(0) ?? 0

        out.push(`${p}fork test`)
        out.push(`${p}  hook test`)
        out.push(`${p}    call not, call is-equal(call ${ops.peekCode}(read(cursor)), code ${code})`)
        out.push(`${p}  hook hold`)
        out.push(inRepetition > 0 ? `${p}    halt` : `${p}    halt <expected ${rule.literal}>`)
        out.push(`${p}  hook miss`)
        out.push(`${p}    call ${ops.advance}(read(cursor))`)
      }

      out.push(`${p}save ${localName}`)
      out.push(`${p}  text <${rule.literal}>`)

      return
    }

    // `mine range` on its OWN, outside an `any`: read one character and require it to be within the bounds. Inside
    // an `any` a range is a branch that compileAnyHelper turns into a test; standing alone in a sequence it had no
    // emitter at all, so JSON's `safe-char` (a `not` followed by a range, which is every character of every string)
    // generated an empty body.
    case 'range': {
      const localName = `char-${sends.length}`
      const baseCode = rule.base.codePointAt(0) ?? 0
      const headCode = rule.head.codePointAt(0) ?? 0

      bindCapture(scope, localName, rule, ops, grammar)
      out.push(`${p}fork test`)
      out.push(`${p}  hook test`)
      out.push(`${p}    call not`)
      out.push(`${p}      call and`)
      out.push(`${p}        call is-minimum(call ${ops.peekCode}(read(cursor)), code ${baseCode})`)
      out.push(`${p}        call is-maximum(call ${ops.peekCode}(read(cursor)), code ${headCode})`)
      out.push(`${p}  hook hold`)
      out.push(inRepetition > 0 ? `${p}    halt` : `${p}    halt <expected a character between ${baseCode} and ${headCode}>`)
      out.push(`${p}save ${localName}`)
      out.push(`${p}  call ${ops.advance}(read(cursor))`)

      return
    }

    // `mine not`: refuse if the next character is one of these, and consume nothing either way. The chain is
    // nested `or`s rather than one call, because `or` takes two.
    case 'not': {
      const test = rule.codes
        .map(code => `call is-equal(call ${ops.peekCode}(read(cursor)), code ${code})`)
        .reduce((left, right) => `call or(${left}, ${right})`)

      out.push(`${p}fork test`)
      out.push(`${p}  hook test`)
      out.push(`${p}    ${test}`)
      out.push(`${p}  hook hold`)
      out.push(`${p}    halt <unexpected character here>`)

      return
    }

    // `mine mark, bind width, code 4`: the nested rules that many times. Unrolled rather than looped, because the
    // width is a constant in the grammar and an unrolled run needs no counter and no list-index arithmetic.
    case 'mark': {
      const localName = rule.send ?? `mark-${sends.length}`
      const parts: string[] = []

      for (let turn = 0; turn < rule.width; turn++) {
        const inner: string[] = []

        compileSequence(rule.children, indent, ops, grammar, scope, nextHelperName, inner, helpers)

        // the last local each turn bound is that turn's result
        const bound = inner
          .filter(line => line.trimStart().startsWith('save '))
          .pop()

        if (bound) {
          parts.push(bound.trim().slice('save '.length))
        }

        out.push(...inner)
      }

      bindCapture(scope, localName, rule, ops, grammar)
      out.push(`${p}save ${localName}`)
      out.push(`${p}  make list`)

      for (const part of parts) {
        out.push(`${p}    read ${part}`)
      }

      return
    }

    // `mine list` NESTED inside another rule (rather than as a whole rule's body, which compileNamedRule handles):
    // repeat the children while the cursor has more, collecting each turn. A span's `mine list / mine range` is
    // this, and without it the span's children emitted nothing at all.
    case 'list': {
      const localName = `list-${sends.length}`

      out.push(`${p}save ${localName}`)
      out.push(`${p}  make list`)
      out.push(`${p}walk test`)
      out.push(`${p}  hook test`)

      // A COUNT-DIRECTED list stops at its count, and it counts with the LIST'S OWN LENGTH rather than a
      // separate counter, so nothing has to be reassigned inside the loop. `walk size` would say this directly
      // and is a view-role construct, not available here.
      //
      // The end-of-input guard stays either way: a truncated file must end the loop rather than read past the
      // end, and a count read from that same file is not to be trusted on its own.
      const bound = rule.count ? shareValue(rule.count) : undefined

      if (bound) {
        out.push(`${p}    call and`)
        out.push(`${p}      call not, call ${ops.atEnd}(read(cursor))`)
        out.push(`${p}      call is-below(call size(read(${localName})), ${bound.text})`)
      } else {
        out.push(`${p}    call not, call ${ops.atEnd}(read(cursor))`)
      }

      out.push(`${p}  hook hold`)

      const before = scope.sends.length
      const inner: string[] = []

      inRepetition++
      compileSequence(rule.children, indent + 2, ops, grammar, scope, nextHelperName, inner, helpers)
      inRepetition--
      out.push(...inner)

      const captured = scope.sends[scope.sends.length - 1] ?? scope.sends[before] ?? 'item'

      out.push(`${p}    call push(read(${localName}), read(${captured}))`)

      scope.sends.push(localName)

      return
    }

    // `bind value / mine text / <rules>`: run the children, then join what they consumed.
    //
    // It reads the locals the children BOUND rather than threading an accumulator into every emitter, because each
    // consuming rule already saves what it read: a `range` or a `char` saves one character, a `list` saves the list
    // it collected. Joining those in order is the text the span covers. A `list` local is a list and a character
    // local is a text, so each is joined on its own and the results concatenated, which `join` over a list of one
    // handles without a special case.
    case 'span': {
      const inner: string[] = []

      inSpan++
      compileSequence(rule.children, indent, ops, grammar, scope, nextHelperName, inner, helpers)
      inSpan--
      out.push(...inner)

      // only the span's OWN saves, at its own indent. A `save` deeper than that belongs to a loop body and is
      // already inside the list that loop collected, so counting it again would repeat every character.
      const bound = inner
        .filter(line => line.startsWith(`${p}save `))
        .map(line => line.trim().slice('save '.length))

      bindCapture(scope, rule.send, rule, ops, grammar)
      out.push(`${p}save ${rule.send}-parts`)
      out.push(`${p}  make list`)

      // Each part becomes text ACCORDING TO ITS OWN TYPE, which the scope already recorded: a character is
      // already text, a list of characters is joined, and an optional part is unwrapped to the empty string when
      // it is absent. Joining every part the same way was wrong in both directions - it fed `join` a maybe, and
      // it fed the result a list where a string belonged.
      for (const name of bound) {
        const kind = (scope.types.get(name) ?? []).join(' ')

        if (kind.startsWith('like maybe')) {
          out.push(`${p}    call unwrap-or(read(${name}), text <>)`)
        } else if (kind.startsWith('like list')) {
          out.push(`${p}    call join(read(${name}), text <>)`)
        } else {
          out.push(`${p}    read ${name}`)
        }
      }

      out.push(`${p}save ${rule.send}`)
      out.push(`${p}  call join(read(${rule.send}-parts), text <>)`)

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

    // a `check` IS a `maybe` with an explicit test, written in the notation the OTF tables use, so it compiles
    // through the same helper rather than through a second path that could drift from it
    case 'check':
    case 'maybe': {
      const localName = rule.send ?? `maybe-${sends.length}`
      const helperName = nextHelperName()
      const built = compileMaybeHelper(
        helperName,
        rule.kind === 'check' ? asMaybe(rule) : rule,
        ops,
        grammar,
        scope,
        nextHelperName,
      )

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

// ---- FIRST sets, for dispatching an `any` whose alternatives are forms ----

// The code points a rule can begin with, as inclusive ranges. This is what lets an `any` over FORM alternatives
// dispatch: JSON's `value` picks string / object / array / literal / number by looking at ONE character, which is
// how every hand-written JSON reader does it too.
//
// A rule that cannot be decided this way returns undefined rather than guessing, and its `any` falls back to the
// old behaviour (refuse) instead of dispatching to the wrong branch. Silence would be worse than a refusal here.
type Span = { base: number; head: number }

function firstOf(
  rule: FeedMineRule,
  grammar: FeedMineGrammar,
  seen: Set<string>,
): Span[] | undefined {
  switch (rule.kind) {
    case 'char':
      return [{ base: rule.literal, head: rule.literal }]
    case 'text': {
      const code = rule.literal.codePointAt(0)

      return code === undefined ? undefined : [{ base: code, head: code }]
    }
    case 'range':
      return [
        {
          base: rule.base.codePointAt(0) ?? 0,
          head: rule.head.codePointAt(0) ?? 0,
        },
      ]
    case 'form':
      return firstOfRule(rule.name, grammar, seen)
    // a span's first characters are its children's, read as a sequence
    case 'span':
      return firstOfSequence(rule.children, grammar, seen)
    // an OPTIONAL rule contributes its own first characters, and the sequence must keep looking past it, because
    // it can be skipped. firstOfSequence is what knows that; on its own a maybe cannot decide anything. A `check`
    // is optional in exactly the same way: its condition may be false.
    case 'check':
    case 'maybe':
      return firstOfSequence(rule.children, grammar, seen)
    case 'list':
      return firstOfSequence(rule.children, grammar, seen)
    case 'any': {
      const out: Span[] = []

      for (const child of rule.children) {
        const spans = firstOf(child, grammar, seen)

        if (!spans) {
          return undefined
        }

        out.push(...spans)
      }

      return out
    }
    // a lookahead and a capture-only rule consume nothing, so they cannot start a rule on their own
    case 'not':
    case 'send':
    case 'value':
    case 'let':
      return undefined
    default:
      return undefined
  }
}

// The first characters a SEQUENCE can begin with: every optional rule's own, plus the first required rule's, then
// stop. A `maybe` can be skipped, so what follows it can also begin the sequence, which is exactly why JSON's
// `number` (an optional sign, then digits) starts with a digit as well as with `-`.
function firstOfSequence(
  rules: FeedMineRule[],
  grammar: FeedMineGrammar,
  seen: Set<string>,
): Span[] | undefined {
  const out: Span[] = []

  for (const rule of rules) {
    // consumes nothing, decides nothing
    if (rule.kind === 'not' || rule.kind === 'send' || rule.kind === 'let' || rule.kind === 'value') {
      continue
    }

    const spans = firstOf(rule, grammar, seen)

    if (!spans) {
      return out.length > 0 ? out : undefined
    }

    out.push(...spans)

    // a required rule ends the search; an optional one lets the next rule begin the sequence too
    if (rule.kind !== 'maybe') {
      return out
    }
  }

  return out.length > 0 ? out : undefined
}

// the FIRST set of a named rule: the first of its first rule that can actually begin it
function firstOfRule(
  name: string,
  grammar: FeedMineGrammar,
  seen: Set<string>,
): Span[] | undefined {
  if (seen.has(name)) {
    return undefined
  }

  const rules = grammar.get(name)

  if (!rules || rules.length === 0) {
    return undefined
  }

  const inner = new Set(seen)

  inner.add(name)

  return firstOfSequence(rules, grammar, inner)
}

function compileAnyHelper(name: string, branches: FeedMineRule[], ops: Ops, grammar: FeedMineGrammar): string[] {
  const ranges = branches.filter((b): b is { kind: 'range'; base: string; head: string } => b.kind === 'range')
  // A helper whose branches are all CHARACTERS returns a character. One with a FORM branch returns whatever that
  // rule returns, and different branches return different things: JSON's `escape` chooses between a character and
  // `unicode-escape`'s four-digit list. `like unknown` is the documented gradual type, consistent with every
  // concrete type in both directions, so it unifies wherever a caller actually uses the value. Declaring `like
  // text` for all of them was right only while every dialect's `any` was ranges.
  const element = branches.some(b => b.kind === 'form')
    ? 'like unknown'
    : ops.cursorType === 'text-cursor'
      ? 'like text'
      : 'like u8'
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

  // DISPATCH ON THE FIRST CHARACTER for alternatives that are FORMS or literals. This is how JSON's `value` picks
  // string / object / array / literal / number, and how every hand-written reader for a format like it works.
  //
  // Only branches whose FIRST set can be computed are dispatched. One that cannot is left out rather than guessed
  // at, so the helper refuses instead of calling the wrong reader: a refusal is a bug report, a wrong branch is a
  // corrupted parse.
  type Dispatch = { branch: FeedMineRule; spans: Span[] }

  const dispatched: Dispatch[] = []

  for (const branch of branches) {
    if (branch.kind !== 'form' && branch.kind !== 'char' && branch.kind !== 'text') {
      continue
    }

    const spans = firstOf(branch, grammar, new Set<string>())

    if (spans && spans.length > 0) {
      dispatched.push({ branch, spans })
    }
  }

  dispatched.forEach(({ branch, spans }, i) => {
    if (i === 0 && ranges.length === 0) {
      lines.push('  fork test')
    }

    const test = spans
      .map(span =>
        span.base === span.head
          ? `call is-equal(read(code), code ${span.base})`
          : `call and(call is-minimum(read(code), code ${span.base}), call is-maximum(read(code), code ${span.head}))`,
      )
      .reduce((left, right) => `call or(${left}, ${right})`)

    lines.push('    hook test')
    lines.push(`      ${test}`)
    lines.push('    hook hold')
    lines.push('      send back')

    if (branch.kind === 'form') {
      lines.push(`        call read-${branch.name}(read(cursor))`)
    } else {
      lines.push(`        call ${ops.advance}(read(cursor))`)
    }
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
// the condition for a `maybe` with no explicit test: the next character is within its own FIRST set. Falls back to
// refusing the branch when the FIRST set cannot be computed, so an undecidable maybe is skipped rather than entered
// on a guess.
function firstTest(children: FeedMineRule[], ops: Ops, grammar: FeedMineGrammar): string {
  const spans: Span[] = []

  for (const child of children) {
    const got = firstOf(child, grammar, new Set<string>())

    if (!got) {
      continue
    }

    spans.push(...got)

    // only the FIRST rule that can begin the body decides it
    break
  }

  if (spans.length === 0) {
    return 'false'
  }

  return spans
    .map(span =>
      span.base === span.head
        ? `call is-equal(call ${ops.peekCode}(read(cursor)), code ${span.base})`
        : `call and(call is-minimum(call ${ops.peekCode}(read(cursor)), code ${span.base}), call is-maximum(call ${ops.peekCode}(read(cursor)), code ${span.head}))`,
    )
    .reduce((left, right) => `call or(${left}, ${right})`)
}

// A `check` as the `maybe` it is. The test is rendered here rather than synthesized as a tree: the two operands
// are already nodes, `shareValue` turns each into the Term that means it, and the names they read are exactly the
// ones the helper has to take as parameters. Building a GroupNode by hand to hand back to `printNode` would be
// the same answer through more machinery, and machinery that could disagree with the one parser.
function asMaybe(rule: {
  op: string
  base: Node
  head: Node
  children: FeedMineRule[]
}): { testText?: string; testReads?: string[]; children: FeedMineRule[] } {
  const base = shareValue(rule.base)
  const front = shareValue(rule.head)

  if (!base || !front) {
    return { children: rule.children }
  }

  return {
    testText: `call ${rule.op}(${base.text}, ${front.text})`,
    testReads: [...base.reads, ...front.reads],
    children: rule.children,
  }
}

function compileMaybeHelper(
  name: string,
  rule: {
    test?: GroupNode
    // a `check`'s test, already rendered, with the outer names it reads. Same meaning as `test`, different source.
    testText?: string
    testReads?: string[]
    children: FeedMineRule[]
  },
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

  // inside a span the payload is the TEXT this maybe consumed, joined from every part it bound, each converted by
  // its own type the way the span converts its own parts. Outside one it is the last capture, as before.
  const payload = valueExpr
    ? printNode(valueExpr)
    : inSpan > 0 && scope.sends.length > 0
      ? `call join(make(list${scope.sends
          .map(name => {
            const kind = (scope.types.get(name) ?? []).join(' ')

            return kind.startsWith('like maybe')
              ? `, call unwrap-or(read(${name}), text <>)`
              : kind.startsWith('like list')
                ? `, call join(read(${name}), text <>)`
                : `, read(${name})`
          })
          .join('')}), text <>)`
      : `read ${scope.sends[scope.sends.length - 1] ?? 'result'}`
  // only the names the test expression reads from OUTSIDE this helper, and each declared as the type the
  // enclosing rule's own capture holds — not `like number` for all of them, which was right only because gzip's
  // four gate tests happen to read one byte-valued `flags` field.
  const params = (
    rule.test
      ? [...freeReads(rule.test)]
      : rule.testReads ?? []
  ).filter(p => outer.types.has(p))
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
    // an explicit `test` is an expression over locals read earlier (gzip's flag bits); an absent one means the
    // maybe is decided by its own FIRST set, which is `does the next character start one of these`
    `      ${
      rule.test
        ? `call is-above(${printNode(rule.test)}, code 0)`
        : rule.testText
          ? `call is-above(${rule.testText}, code 0)`
          : firstTest(rule.children, ops, grammar)
    }`,
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
