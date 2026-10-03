// The formatter: re-print a `.tree` CST in canonical form. Operates on the concrete syntax tree (so comments are
// preserved) and prints from the tree, never from the input's layout, so it is idempotent by design.
//
// THE LAYOUT is the five rules in note/term/format-rules.md, "Where each part of a line goes":
//
//   1. a statement is one line: `push items, 2`
//   2. Term's own words chain with commas: `save items, make list, 3, 1`, `like list, like number`
//   3. a call in statement or CONDITION position reads with commas (`fork test, is-above n, 0`), and a call in
//      VALUE position takes parentheses (`back multiply(n, 2)`, `push result, read-number(cursor)`)
//   4. a block stacks from the block on, and the parts before it stay on the head line: `map items` over its `task`
//   5. past 84 columns, or with a comment inside, the group stacks
//
// THE CHECK is meaning, at two levels. Each group's own rendering is accepted only when it re-parses to the group
// it was printed from (`shape()`), which is what keeps a comma from landing one level off. And the whole result is
// accepted only when its MILLED program and its import paths are identical to the input's (format/meaning.ts, the
// comparison test/format/sweep.ts makes over the repository). The second is what can see what a tree cannot: the
// parser keeps no node for parentheses, so `f()` (a call) and a bare `f` (the task itself) are one tree, and so are
// `host(route, port)` (a call) and `host route, port` (a constant). A result that fails it is refused and the file
// is returned as written. Pure and browser-safe.
//
// Every layout the five rules ask for re-parses to the tree it came from, so the tree check never refuses one. The
// one rewrite rule 2 could ask for that changes the tree, `make list(3, 1)` to `make list, 3, 1`, is NOT the same
// program: the mill reads `make list(3, 1)` as the empty list (2026-10-03, tmp/layout/c.tree), so the formatter
// does not make it.

import { escapeTextChunks, parse } from '@term/make/code/parser/tree'
import type {
  GroupNode,
  NameNode,
  Node,
  RootNode,
} from '@term/make/code/parser/tree'
import { importsOf, programOf } from '@term/make/code/format/meaning'

const WIDTH = 84

// definition heads whose group never collapses onto one line: the head stays on its own line with its children
// indented below, the convention for top-level declarations.
//
// `view` is here for the same reason `task` and `form` are: its children are a BODY, not arguments. Collapsing is
// meaning-preserving (a comma returns to the head, so the tree is identical) but a whole component, or a whole
// document in the `view` role, rendered onto one line reads as nothing at all. Was `zone` until 2026-08-30 and
// was never in this set, so a short component collapsed then too.
// Control flow is in here for the same reason: `walk`, `fork` and their `hook` / `case` arms hold a BODY, not an
// argument list. `walk list, read(xs), hook(next, take(site, name(item)), save(n, code 1))` is a real thing this
// produced before they were named, and it is unreadable.
//
// `deck` is here because a package MANIFEST is a block of fields, one per line, which is how `term wake`,
// writeManifest (`term move`) and writeLockfile all write it. Without it a fresh scaffold collapsed to
// `deck demo, bear(./code), test(./test), code <0.0.1>, boot ./code/boot`, so the first project anyone made failed
// `term form --check` on a file it had never touched. A member line (`deck ./deck/load`) has one leaf child and still
// prints on one line, because a group with no children of its own is not a body.
const ALWAYS_STACK = new Set(['load', 'task', 'form', 'view', 'walk', 'fork', 'sift', 'hook', 'case', 'deck'])

// the arms of a lean `fork` and of a `walk test`: `hold` and `miss` hold a body there, and only there. Elsewhere
// `hold` is a statement over one expression (`hold is-equal(a, b)` in a proof or a contract)
const ARMS = new Set(['hold', 'miss'])

// heads that DECLARE rather than call: their children name and type a thing. One of these does not collapse when a
// non-last child would have to be parenthesized, because such a child is another declaration. See needsParens.
const DECLARATION_HEADS = new Set([
  'host',
  'take',
  'save',
  'link',
  'slot',
  'free',
  'mark',
  'like',
  'head',
])

// Term's own words: the heads the language reserves, from note/term/lean.md "The vocabulary that stays" (the same
// list task/term/lean-convert.ts keeps), with `sift`, `tick`, `want` and the proof steps `show`, `calm`, `cite`,
// `seek` and `melt` (a `show hold, C` reads C as a condition, like `want hold, C`). A group headed by one of these is not a
// call, so rule 3 never parenthesizes it. Left OUT are the reserved words that are also ordinary task names and
// stand in a value position as calls (`size(seen)`, `find(xs, f)`, `list`, `next`, `step`): a mode word (`walk
// size`, `hook next`) is a leaf, and a leaf takes no parentheses either way. `test` stays in: a `test <name>` block
// read as a call made every statement in it a value, `log(<parts: {size(parts)}>)`.
const TERM_WORDS = new Set(
  `load form task host hook bind bear deck dock note save tell hold suit mask wear book kink lace cast tune view
   rule roll beam slot call head take like mark wait risk hide fold tag link case bond rein send back fork walk turn
   halt bust rest free move read make fuse loan code text term meet true false void miss fall else have must down
   name tree seed sift tick want show calm cite seek melt test`
    .split(/\s+/)
    .filter(Boolean),
)

// how a tree is printed.
//
// `wrap: false` keeps every comment line exactly as written, for a tool that rewrites code and must not also reflow
// prose (the lean converter): wrapping one physical line at a time breaks a paragraph written at a wider width into
// ragged halves.
//
// `stack` names heads to keep stacked beyond ALWAYS_STACK, for a tool whose output adds body-holding heads the
// canonical set does not list (the lean converter's `hold` and `miss` arms).
//
// `calls: false` turns rule 3 off: a dialect whose heads are not calls (a mill grammar, a `view` document) gets no
// parentheses around a word that only looks like a call. Off for the `mill` and `view` roles.
//
// `lean` and `role` are the file's, as the build reads them (projectLeanOf / projectRoleOf in call/code/role-of.ts):
// the meaning check mills the file the way the build does, and a lean file milled as longhand is another program.
export type FormatOptions = {
  wrap?: boolean
  stack?: Set<string>
  calls?: boolean
  lean?: boolean
  role?: string | null
  // a grammar's dialect (see isGrammar): no rule 3, and no stacking a group for a block beneath it
  dialect?: boolean
}

// ---- reading a group ----

// the head of a group as written, or '' when it is not a plain word
function headName(group: GroupNode): string {
  const head = group.nodes[0]

  return head ? flatten(head) : ''
}

// a word spelled in plain chunks, or undefined
function plainWord(node: Node | undefined): string | undefined {
  const name: NameNode | undefined =
    node?.kind === 'name'
      ? node
      : node?.kind === 'group' && node.nodes.length === 1 && node.nodes[0]!.kind === 'name'
        ? (node.nodes[0] as NameNode)
        : undefined

  if (!name || !name.parts.every(part => part.kind === 'chunk')) {
    return undefined
  }

  return name.parts.map(part => (part.kind === 'chunk' ? part.text : '')).join('')
}

// a word's last token is followed straight away by `(`: `host(` and `f(` read so. The tree keeps no node for
// parentheses, so this is read off the token stream, exactly as compile/mint-bridge.ts reads it
function opensParen(node: Node | undefined): boolean {
  const last = node?.kind === 'name' ? node.parts[node.parts.length - 1] : undefined

  return last?.kind === 'chunk' && (last.token as { next?: { kind: string } }).next?.kind === 'open-paren'
}

// `f()`: a call with no arguments, which parses exactly as the bare word `f` (the task itself). Only the token
// stream remembers the parentheses, so the formatter re-emits them from there or drops a call in silence
function emptyParens(node: Node | undefined): boolean {
  const last = node?.kind === 'name' ? node.parts[node.parts.length - 1] : undefined

  if (last?.kind !== 'chunk') {
    return false
  }

  const open = (last.token as { next?: { kind: string; next?: { kind: string } } }).next

  return open?.kind === 'open-paren' && open.next?.kind === 'close-paren'
}

// a group that is a CALL: a plain word or a path (`items/push`, `console/log`) with parts of its own, whose first
// segment is not one of Term's own words
function isCall(group: GroupNode): boolean {
  if (group.nodes.length < 2) {
    return false
  }

  const word = plainWord(group.nodes[0])

  return word !== undefined && /^[a-z][a-z0-9-]*(\/[a-z0-9-]+)*$/.test(word) && !TERM_WORDS.has(word.split('/')[0]!)
}

// the source line a group's head word was written on
function writtenLine(node: Node | undefined): number | undefined {
  const head = node?.kind === 'group' ? node.nodes[0] : node
  const first = head?.kind === 'name' ? head.parts[0] : undefined

  return first?.kind === 'chunk' ? first.token.span.start.line : undefined
}

// IN A LEAN FILE A BARE HEAD UNDER A CALL IS A LABEL OR A CALL, and only the checker knows which: `gap height 3`
// passes `height` by name when `gap` has a parameter called `height`, and calls a task `height` when it does not
// (note/term/lean.md). Outside lean it is always a call, which is what lets rule 3 add the parentheses there. In a
// lean file the formatter cannot tell, so it neither adds nor removes one: a call-shaped part keeps the spelling it
// was written in, closed `f(x)` or open `width 4`, and one written on a line of its own stays there. This is the one
// place the formatter reads the input's layout, and only to keep a decision it has no grounds to change.
function leanLocked(kid: Node, parent: GroupNode, options: FormatOptions): boolean {
  return (
    options.lean === true &&
    kid.kind === 'group' &&
    isCall(kid) &&
    !opensParen(kid.nodes[0]) &&
    writtenLine(kid) !== undefined &&
    writtenLine(kid) !== writtenLine(parent)
  )
}

// does a one-line rendering of this group have to move a lean call-shaped part off its own line?
function holdsLeanLocked(group: GroupNode, options: FormatOptions): boolean {
  return (
    options.lean === true &&
    group.nodes.slice(1).some(kid => leanLocked(kid, group, options) || (kid.kind === 'group' && holdsLeanLocked(kid, options)))
  )
}

// Which parts of a group stand where a VALUE is expected (rule 3). The arguments of a call; what follows `back`,
// `wait` and `tick`; the value after the name in `save x,`, `host x,`, `bind k,`, `send back,`, the items after the
// form in `make list,`, a longhand `call f`'s arguments; what `walk` and `sift` read. A CONDITION is not a value:
// `fork test, C`, `hook test, C`, `walk test, C` and `want hold, C` keep C a sentence with commas.
function valueKids(group: GroupNode): boolean[] {
  const kids = group.nodes.slice(1)
  const first = plainWord(kids[0])

  if (isCall(group)) {
    return kids.map(() => true)
  }

  switch (plainWord(group.nodes[0])) {
    case 'back':
    case 'wait':
    case 'tick':
    case 'fall':
    case 'read':
      return kids.map(() => true)
    case 'save':
    case 'host':
    case 'bind':
    case 'make':
    case 'send':
    case 'call':
      return kids.map((_, i) => i >= 1)
    case 'walk':
      return kids.map((_, i) => first !== 'test' && (i === 0 || first === 'list'))
    case 'sift':
      return kids.map((_, i) => i === 0)
    case 'fork':
      return kids.map((_, i) => first === 'case' && i >= 1)
    default:
      return kids.map(() => false)
  }
}

// a `view` PLACEMENT inside a body (not the top-level definition) whose only content is one simple value: a text
// (`view h1, <Home>`) or a bare variable (`view p, who`). It holds no body, so it goes on one line like any other
// single-child value, where a definition or a placement with markup under it stays stacked.
function isSimplePlacement(group: GroupNode, depth: number): boolean {
  if (depth === 0 || headName(group) !== 'view' || group.nodes.length !== 3) {
    return false
  }

  const [, tag, value] = group.nodes

  const word = (node: Node | undefined) =>
    node?.kind === 'group' && node.nodes.length === 1 && node.nodes[0]!.kind === 'name'

  return word(tag) && (value?.kind === 'text' || word(value))
}

// a BLOCK (rule 4): a group that holds a body. A `task`, `walk`, `fork`, `sift`, `case`, `hook`, `form`, `view`,
// `load` or `deck` with parts of its own, a lean arm under a `fork` or `walk`, or a head the caller names. A word
// alone holds nothing, so `like task` and `deck ./deck/load` are not blocks
function isBlock(node: Node, depth: number, parent: GroupNode | undefined, options: FormatOptions): boolean {
  if (node.kind !== 'group' || node.nodes.length < 2) {
    return false
  }

  const head = headName(node)

  const first = plainWord(node.nodes[1])

  return (
    (ALWAYS_STACK.has(head) && !isSimplePlacement(node, depth)) ||
    BODIES.has(head) ||
    options.stack?.has(head) === true ||
    (ARMS.has(head) && parent !== undefined && isArmParent(parent)) ||
    // a guarded body and its handler: `mark unsafe` over statements, `halt take` over `take e` and statements
    (head === 'mark' && first === 'unsafe' && node.nodes.length > 2) ||
    (head === 'halt' && first === 'take' && node.nodes.length > 2) ||
    // an event handler in a view, `seed click` over the call it runs, as against an attribute, `seed type, <email>`
    (head === 'seed' && first !== undefined && node.nodes.slice(2).some(kid => kid.kind === 'group' && kid.nodes.length > 1))
  )
}

// the other heads that hold a body, beside ALWAYS_STACK: a proof (`rule`) and its induction step (`fold n` over
// its `cite`s), a test, a mask, a template definition.
// The list L044 kept before it became rule 4. Without it `rule some-double, find(x, like(integer), 3), show ...`
// was one line in the proofs guide.
const BODIES = new Set(['rule', 'test', 'mask', 'tree', 'fold'])

// a lean `fork`, or a `walk test`: the groups whose `hold` and `miss` are arms
function isArmParent(group: GroupNode): boolean {
  const head = headName(group)

  return head === 'fork' || (head === 'walk' && plainWord(group.nodes[1]) === 'test')
}

// does any part beneath this group hold a body? Such a group stacks, from the block on
function holdsBlock(group: GroupNode, options: FormatOptions): boolean {
  if (options.dialect === true) {
    return false
  }

  return group.nodes.slice(1).some(kid => isBlock(kid, 1, group, options) || (kid.kind === 'group' && holdsBlock(kid, options)))
}

function isLeaf(node: Node): boolean {
  return node.kind !== 'group' || node.nodes.length <= 1
}

// does this group (or any descendant) carry a comment? Inlining would drop those comments, so such groups stack.
//
// A line that opens with a literal or a text carries its comments on that node, not on a group: `push` over `items`,
// `# the second` and `2` put the comment on the `2`. Missing it here inlined the group and dropped the comment.
function hasComment(node: Node): boolean {
  const own = 'comments' in node ? ((node.comments as unknown[] | undefined)?.length ?? 0) : 0

  return own > 0 || (node.kind === 'group' && node.nodes.some(hasComment))
}

// ---- printing ----

// The inline (comma-joined) rendering of a node: `head a, b, c`.
//
// A part that a COMMA FOLLOWS and has parts of its own is written PARENTHESIZED (`loan(n)`). A comma pops exactly
// one level, so `call add, loan n, code 1` reads `code 1` as a child of `loan`, and `add` gets one argument.
// `loan(n)` closes its own group, so the comma lands where it belongs. The last part needs nothing after it.
//
// Rule 3 adds the parentheses where the tree does not force them: a call standing in a VALUE position is written
// `multiply(n, 2)` even as the last part, which re-parses to the same group either way. `value` says the node
// stands in one.
function flatten(node: Node, nested = false, value = false, options: FormatOptions = {}): string {
  switch (node.kind) {
    case 'group': {
      const [head, ...kids] = node.nodes
      const h = head ? flatten(head) : ''
      const optional = node.optional ? '?' : ''

      if (!kids.length) {
        return `${h}${emptyParens(head) ? '()' : ''}${optional}`
      }

      const places = valueKids(node)
      const args = kids.map((k, i) => flatten(k, forcedClosed(node, i), places[i], options))

      // `host(route, port)` is a call to a task named `host`, and `host route, port` is the constant: the
      // parenthesis straight after the word is all that tells them apart, so it is kept wherever it was written
      //
      // In a lean file a call-shaped part keeps the parentheses it was written with, neither more nor fewer (see
      // leanLocked): there it may be a label, and `width(4)` would read as a call to a task named `width`
      const closed = nested || printedClosed(node, value, options)

      return closed ? `${h}${optional}(${args.join(', ')})` : `${h}${optional} ${args.join(', ')}`
    }

    case 'name':
      // an interpolation is re-emitted at ITS OWN brace depth, never a fixed `{{...}}`. A single brace is
      // compile-time SUBSTITUTION and a double brace is RUNTIME interpolation, so hardcoding two turned
      // `load @term/base/code/native/{platform}/atomic` into `{{platform}}` and changed what the line means:
      // every platform-slot import in the stdlib, silently, the moment anyone ran `term form` over it.
      return node.parts
        .map(p =>
          p.kind === 'chunk'
            ? p.text
            : `${'{'.repeat(p.depth)}${p.group ? flatten(p.group, false, true, options) : ''}${'}'.repeat(p.depth)}`,
        )
        .join('')
    case 'text': {
      // the same re-escaping printTree does, computed across the WHOLE literal: an angle that cannot balance has
      // to come back out escaped or the formatted literal reads as a nested bracket and stops parsing, while a
      // balanced one is content and must be left exactly as it is
      const escaped = escapeTextChunks(
        node.parts.filter((p): p is typeof p & { kind: 'chunk' } => p.kind === 'chunk').map(p => p.text),
      )
      let at = 0

      // the SAME depth rule as the `name` case above, for the same reason: `{x}` is a compile-time template
      // (and the view dialect's field interpolation), `{{x}}` is runtime interpolation, and hardcoding two
      // braces here turned a document's `text <{sound/symbol}>` into `text <{{sound/symbol}}>` — a different
      // construct — the moment anyone canonicalized a guide.
      return `<${node.parts
        .map(p =>
          p.kind === 'chunk'
            ? escaped[at++]!
            : // what an interpolation holds is a VALUE (rule 3): `<problem: {read-signal(problem)}>`
              `${'{'.repeat(p.depth)}${p.group ? flatten(p.group, false, true, options) : ''}${'}'.repeat(p.depth)}`,
        )
        .join('')}>`
    }
    case 'integer':
    case 'decimal':
    case 'radix':
      return node.token.text
    default:
      return ''
  }
}

// a comparable structural fingerprint (ignores comments, spans, parents): used to verify a rendering round-trips
function shape(node: Node): string {
  switch (node.kind) {
    case 'root':
      return `R(${node.nodes.map(shape).join(',')})`
    case 'group':
      return `G${node.optional ? '?' : ''}(${node.nodes
        .map(shape)
        .join(',')})`
    case 'name':
      return `n:${flatten(node)}`
    case 'text':
      return `t:${flatten(node)}`
    default:
      return `l:${flatten(node)}`
  }
}

// does `text`, read alone as one line, parse to exactly `nodes` under one group?
function readsAs(text: string, nodes: GroupNode['nodes']): boolean {
  const reparsed = parse({ file: 'format', text })

  return (
    reparsed.ok &&
    reparsed.tree.nodes.length === 1 &&
    shape(reparsed.tree.nodes[0]!) === shape({ kind: 'group', nodes })
  )
}

// the declaration heads that make up a task's signature (before its body). Runs of the same head group together;
// a head change inside the signature, and the signature->body boundary, each get a blank line.
const SIGNATURE_HEADS = new Set([
  'take',
  'free',
  'like',
  'mark',
  'hold',
])

// `mark <word>` where the word is one the mill reads as metadata (note/mine.tree, `mine mark-note`): a bare word,
// nothing under it but a guarded body under `unsafe`
const METADATA_MARKS = new Set(['async', 'native', 'unsafe', 'draft', 'stable', 'unstable', 'deprecated', 'keep', 'open', 'roam'])

function isMetadataMark(group: GroupNode): boolean {
  const word = group.nodes[1]

  return (
    word !== undefined &&
    word.kind === 'group' &&
    word.nodes.length === 1 &&
    METADATA_MARKS.has(flatten(word.nodes[0]!).replace(/^l:/, '')) &&
    (group.nodes.length === 2 || flatten(word.nodes[0]!).endsWith('unsafe'))
  )
}

// would this child have to be PARENTHESIZED to survive an inline rendering? That is the same test `flatten` makes,
// and it is the tell that the child is a DECLARATION rather than an atom: it has a head and children of its own.
//
// A group with such a child is not collapsed, however well it fits. Two real examples from the stdlib:
//
//   host h, host(start, code 0), host end, code 360        was three legible lines
//   take precise, like(boolean), fall false                was four
//
// It applies to DECLARATION heads only. `call is-below, loan(n), code 2` is a call with arguments, and
// parenthesizing an argument reads fine.
function needsParens(node: Node): boolean {
  return (
    node.kind === 'group' &&
    node.nodes.length > 1 &&
    node.nodes
      .slice(1)
      .some(k => k.kind === 'name' || k.kind === 'group')
  )
}

// Would a one-line rendering have to close one of Term's own words in parentheses around two or more parts, as in
// `insert seen, make point, bind(x, 1), bind y, 2`? Parentheses are how rule 3 writes a CALL, so `bind(x, 1)` reads
// as a call to a task named `bind`, which it is not. Such a group stacks instead, and each `bind` gets its own line.
// A word over ONE part, `read(a)`, `code(1)`, `loan(n)`, is the longhand's own argument spelling (`call add,
// read(a), read(b)`) and stays.
//
// The same holds INSIDE parentheses: `plus(a, make succ, bind prior, b)` is one tree with `make` over three parts,
// and reads as `plus` over four. A part of two or more parts that is not itself closed, inside a closed call,
// stacks its line too. `closed` says the group is printed in parentheses.
//
// And a declaration that holds another, `take on-submit, like task, take email, like text`, is one tree with the
// second `take` under `like task`, and reads as four parts of the first. It stacks, as a task-typed parameter always
// has: `take on-submit` over `like task` over `take email, like text`.
function closesAWord(group: GroupNode, options: FormatOptions, closed = false): boolean {
  const kids = group.nodes.slice(1)
  const places = valueKids(group)

  // a grammar's words are not Term's (see isGrammar)
  if (options.dialect === true) {
    return false
  }

  if (DECLARATION_HEADS.has(headName(group)) && holdsDeclaration(group)) {
    return true
  }

  return kids.some((kid, i) => {
    if (kid.kind !== 'group' || kid.nodes.length < 2) {
      return false
    }

    const forced = forcedClosed(group, i)
    const shut = forced || printedClosed(kid, places[i] ?? false, options)
    const word = !isCall(kid)
    // a value word over one part is the longhand's own argument spelling, `read(a)`, `code(1)`
    const valueWord = VALUE_WORDS.has(headName(kid)) && kid.nodes.length === 2

    if ((forced && word && !valueWord) || (closed && !shut && kid.nodes.length > 2)) {
      return true
    }

    return closesAWord(kid, options, closed || shut)
  })
}

// the words that head a literal or a read, which longhand writes closed as an argument: `call add, read(a), code(1)`
const VALUE_WORDS = new Set(['read', 'code', 'text', 'term', 'loan'])

// the declarations that may sit only on a line of their own inside another
const INNER_DECLARATIONS = new Set(['take', 'link', 'slot', 'free'])

function holdsDeclaration(group: GroupNode): boolean {
  return group.nodes
    .slice(1)
    .some(
      kid =>
        kid.kind === 'group' &&
        ((INNER_DECLARATIONS.has(headName(kid)) && kid.nodes.length > 1) || holdsDeclaration(kid)),
    )
}

// is part `i` of a group closed in parentheses whatever its place: a part a comma follows, or the task a longhand
// `call` names when it carries its own arguments, `call f(a, b)`
function forcedClosed(group: GroupNode, i: number): boolean {
  const kid = group.nodes[i + 1]

  return (
    i < group.nodes.length - 2 ||
    (i === 0 && plainWord(group.nodes[0]) === 'call' && kid?.kind === 'group' && kid.nodes.length > 1)
  )
}

// is a group that is the LAST part of its line printed in parentheses (flatten's own decision)
function printedClosed(group: GroupNode, value: boolean, options: FormatOptions): boolean {
  const head = group.nodes[0]

  return (
    (options.calls !== false && value && isCall(group) && options.lean !== true) ||
    (options.lean === true && isCall(group) && opensParen(head)) ||
    (plainWord(head) === 'host' && opensParen(head))
  )
}

// word-wrap a comment so no line exceeds WIDTH. A comment that already fits is emitted unchanged (so short directive
// comments like `# lint off L003` are never disturbed). A word longer than the available width (e.g. a bare URL) is
// left on its own line rather than broken mid-word.
function wrapComment(text: string, indent: string): string[] {
  const trimmed = text.trim()

  if (indent.length + trimmed.length <= WIDTH) {
    return [`${indent}${trimmed}`]
  }

  const body = trimmed.replace(/^#+\s?/, '')
  const prefix = '# '
  const max = WIDTH - indent.length
  const lines: string[] = []

  let line = prefix

  for (const word of body.split(/\s+/)) {
    if (line === prefix) {
      line = prefix + word
    } else if (line.length + 1 + word.length <= max) {
      line += ` ${word}`
    } else {
      lines.push(`${indent}${line}`)
      line = prefix + word
    }
  }

  if (line !== prefix) {
    lines.push(`${indent}${line}`)
  }

  return lines
}

function comments(node: Node, indent: string, options: FormatOptions): string[] {
  const own = 'comments' in node ? ((node.comments as { text: string }[] | undefined) ?? []) : []

  return own.flatMap(c =>
    options.wrap === false ? [`${indent}${c.text.trim()}`] : wrapComment(c.text, indent),
  )
}

// How many parts ride on a stacked group's head line, and the line itself. Rule 4: the parts before the first
// block stay on the head line. Rule 5: a group that stacks for width or a comment keeps one leading part there.
//
// A part rides when it is a word or literal, or when it closes itself: a call in parentheses, `walk split(text,
// <,>)`, `map get(xs, 0)`. The last rider may be a sentence with commas, which is how a condition reads on its fork,
// `fork test, is-above n, 0`, and how a longhand loop reads, `walk list, read xs`. Every rider line is re-parsed and
// must read as the head over exactly those parts, since the indented lines below it attach to the head of the line.
// A space NESTS, so two leaves are never joined by a space: `hook test true` re-reads as `hook > test > true`.
function headLine(
  group: GroupNode,
  depth: number,
  options: FormatOptions,
  places: boolean[],
  parent: GroupNode | undefined,
): { count: number; text: string } {
  const indent = '  '.repeat(depth)
  const [head, ...kids] = group.nodes
  const h = head ? flatten(head) : ''

  // the parts a block-holding group may carry before its body
  let limit = 1
  const word = headName(group)

  if (ARMS.has(word) && parent !== undefined && isArmParent(parent)) {
    // a lean arm's parts are all its body: `hold` over `halt`, never `hold halt`
    limit = 0
  } else if (word === 'walk' && ['list', 'test'].includes(plainWord(kids[0]) ?? '')) {
    limit = 2
  } else if (['fork', 'hook'].includes(word) && ['test', 'case'].includes(plainWord(kids[0]) ?? '')) {
    // the condition reads on its own head line: `fork test, is-above n, 0`, `hook test, is-minimum score, 90`
    limit = 2
  } else if (word === 'load' && kids.length === 2 && kids[1]?.kind === 'group' && headName(kids[1]) === 'name') {
    // a native import and its alias, `load <node:fs/promises>, name fs-promise`
    limit = 2
  } else if (DECLARATION_HEADS.has(word) && plainWord(kids[0]) !== undefined && kids[1]?.kind === 'group' && headName(kids[1]) === 'like') {
    // a declaration keeps its name and its type together, `host tense, like dimension`, as `take n, like number` does
    limit = 2
  } else if (!isBlock(group, depth, parent, options)) {
    // a group that holds a block without being one (`map items` over a `task`): every part before the block. A
    // block itself (`rule plus-zero` over its `mark` lines) keeps its one name
    const block = kids.findIndex(kid => isBlock(kid, depth + 1, group, options) || (kid.kind === 'group' && holdsBlock(kid, options)))

    limit = block > 0 ? block : 1
  }

  let count = 0

  for (let n = Math.min(limit, kids.length); n > 0; n--) {
    const riders = kids.slice(0, n)

    const fit = riders.every(
      (kid, i) =>
        !hasComment(kid) &&
        !isBlock(kid, depth + 1, group, options) &&
        !(kid.kind === 'group' && holdsBlock(kid, options)) &&
        !leanLocked(kid, group, options) &&
        !(
          kid.kind === 'group' &&
          (holdsLeanLocked(kid, options) ||
            closesAWord(kid, options, i < n - 1 || printedClosed(kid, places[i] ?? false, options)))
        ) &&
        // a part a comma follows that is not a word must close itself, and only a call reads well closed
        (i === n - 1 || isLeaf(kid) || (kid.kind === 'group' && isCall(kid))),
    )

    if (!fit) {
      continue
    }

    // the old, single-word head line: kept exactly, the optional marker at its end
    if (n === 1 && isLeaf(riders[0]!)) {
      return { count: 1, text: `${indent}${h} ${flatten(riders[0]!, false, places[0], options)}${group.optional ? '?' : ''}` }
    }

    if (group.optional) {
      continue
    }

    // one part that is not a word rides only when it closes itself, so a long sentence never sits on a head line
    if (n === 1 && !(riders[0]!.kind === 'group' && isCall(riders[0]!) && places[0])) {
      continue
    }

    const text = `${h} ${riders.map((kid, i) => flatten(kid, i < n - 1, places[i], options)).join(', ')}`

    if (indent.length + text.length <= WIDTH && readsAs(text, [head!, ...riders])) {
      count = n

      return { count, text: `${indent}${text}` }
    }
  }

  return { count: 0, text: `${indent}${h}${group.optional ? '?' : ''}` }
}

function formatGroup(
  group: GroupNode,
  depth: number,
  options: FormatOptions = {},
  value = false,
  parent?: GroupNode,
): string[] {
  const indent = '  '.repeat(depth)
  // a line that opens with a literal or a text keeps its comments on that node
  const lines = [
    ...comments(group, indent, options),
    ...(group.nodes[0] && group.nodes[0].kind !== 'group' ? comments(group.nodes[0], indent, options) : []),
  ]
  const flat = flatten(group, false, value, options)

  // rules 1, 4 and 5: one line when the group holds no block, carries no comment to preserve, fits, and re-parses to
  // the same group. The whole result is then held to the same MILLED program as the input (formatReport).
  if (
    !isBlock(group, depth, parent, options) &&
    !holdsBlock(group, options) &&
    !group.nodes.some(hasComment) &&
    // a NON-LAST child that would need parentheses is another declaration, not an argument: see needsParens. The
    // last part is exempt for the same reason `flatten` exempts it, and it is the difference between the house
    // `take n, like number` (fine) and `take precise, like(boolean), fall false` (three lines squashed into one).
    !(
      DECLARATION_HEADS.has(headName(group)) &&
      group.nodes.slice(1, -1).some(needsParens)
    ) &&
    !closesAWord(group, options, printedClosed(group, value, options)) &&
    !holdsLeanLocked(group, options) &&
    indent.length + flat.length <= WIDTH &&
    readsAs(flat, group.nodes)
  ) {
    lines.push(`${indent}${flat}`)

    return lines
  }

  const kids = group.nodes.slice(1)
  const places = valueKids(group)
  const head = headLine(group, depth, options, places, parent)

  lines.push(head.text)

  // blank-line grouping inside a task body: signature lines (take / like / mark ...) are grouped by head, the first
  // real statement is set off from the signature, and a multi-line block is set off from a preceding simple statement.
  // A block followed by a statement (or two adjacent blocks) stays tight, so the indentation provides the separation.
  // Other constructs (fork / walk / make / form ...) keep their children tight; only function bodies breathe.
  const spaceBody = headName(group) === 'task'

  let prevHead: string | undefined
  let prevSignature = false
  let prevCompound = false

  kids.forEach((kid, i) => {
    if (i < head.count) {
      return
    }

    const kidLines =
      kid.kind === 'group'
        ? formatGroup(kid, depth + 1, options, places[i], group)
        : [
            ...comments(kid, '  '.repeat(depth + 1), options),
            `${'  '.repeat(depth + 1)}${flatten(kid, false, places[i], options)}`,
          ]

    const written =
      kid.kind === 'group'
        ? headName(kid)
        : (flatten(kid).split(/[\s,]/)[0] ?? '')
    // metadata written `mark async` lays out exactly as its old spelling `note async` did, so the rewrite from one
    // to the other moves no line (note/term/plan/await-by-default-and-mark-metadata.md). `mark private` and the
    // other marks keep their place in the signature
    const kidHead = written === 'mark' && kid.kind === 'group' && isMetadataMark(kid) ? 'note' : written

    const signature = SIGNATURE_HEADS.has(kidHead)
    const compound = kidLines.length > 1

    if (spaceBody && prevHead !== undefined) {
      const blank =
        prevSignature && signature
          ? kidHead !== prevHead // group signature entries by head
          : prevSignature && !signature
            ? true // signature -> body boundary
            : compound && !prevCompound // set a block off from a preceding simple statement

      if (blank) {
        lines.push('')
      }
    }

    lines.push(...kidLines)
    prevHead = kidHead
    prevSignature = signature
    prevCompound = compound
  })

  return lines
}

// one group laid out as the formatter lays it out at `depth`, one string per line, comments included. `value` says
// the group stands in a value position (rule 3) and `parent` is the group it sits under. For the layout lint (L044),
// which asks whether a group is written the way `term form` writes it.
export function formatGroupLines(
  group: GroupNode,
  depth: number,
  options: FormatOptions = {},
  value = false,
  parent?: GroupNode,
): string[] {
  return formatGroup(group, depth, options, value, parent)
}

// which parts of a group stand in a value position (rule 3), for a caller walking the tree beside the formatter
export function valuePlaces(group: GroupNode): boolean[] {
  return valueKids(group)
}

// A GRAMMAR (a `mine` or `mint` file, or one in the `mill` role) is a dialect: its heads are not calls and its
// `form` is a reference, not a definition. `formatReport` returns one as written, since no layout rules for a
// grammar are written down and the code rules made the parsers guide's grammar `mine(char, <.>)`, with `form
// digits` on a line of its own. The layout as it stood before, before rule 3 and rule 4, is what `formatTree`
// still gives a caller that holds only the tree: one that collapsed a whole `mine` rule onto one line.
function isGrammar(tree: RootNode, options: FormatOptions): boolean {
  return (
    options.role === 'mill' ||
    tree.nodes.some(group => {
      const head = headName(group)

      return head === 'mine' || head === 'mint'
    })
  )
}

function calling(options: FormatOptions, tree: RootNode): FormatOptions {
  const grammar = isGrammar(tree, options)

  return {
    ...options,
    calls: options.calls ?? (!grammar && options.role !== 'view'),
    dialect: options.dialect ?? grammar,
  }
}

function printTreeLaid(tree: RootNode, options: FormatOptions): string {
  // one blank line between top-level definitions; comments ride with their group
  return (
    tree.nodes
      .map(group => formatGroup(group, 0, options).join('\n'))
      .join('\n\n') + '\n'
  )
}

// The layout, from the tree, with no meaning check: for a caller that holds only a tree (the lean converter, the
// language server's fix). Every per-group rendering is still checked against its group.
export function formatTree(tree: RootNode, options: FormatOptions = {}): string {
  return printTreeLaid(tree, calling(options, tree))
}

export type FormatReport = {
  text: string
  // why the result was refused and the file returned as written, when it was
  refused?: string
}

// Format source text, and say what happened. Tolerant: a file that does not parse comes back unchanged.
//
// A file that MILLS is held to its own meaning: the formatted text must mill to the same program, with the same
// import paths, or it is refused and returned as written. A file that does not mill (a fixture, a grammar, a
// document, a file with an error the mill reports) has no program to compare, and gets the layout alone, every group
// of it re-parsed to the group it came from.
export function formatReport(source: { file: string; text: string }, options: FormatOptions = {}): FormatReport {
  const result = parse(source)

  if (!result.ok) {
    return { text: source.text }
  }

  // a grammar is returned as written: the five rules are about Term's own words, and a grammar's are not
  if (isGrammar(result.tree, options)) {
    return { text: source.text }
  }

  const laid = calling(options, result.tree)
  const lean = options.lean ?? false
  const text = printTreeLaid(result.tree, laid)
  const meaningful = options.role !== 'mill' && options.role !== 'view'
  const before = meaningful ? programOf(result.tree, source.file, lean) : undefined

  if (before === undefined) {
    return { text }
  }

  const reparsed = parse({ file: source.file, text })
  const same =
    reparsed.ok &&
    programOf(reparsed.tree, source.file, lean) === before &&
    importsOf(source.file, text) === importsOf(source.file, source.text)

  return same
    ? { text }
    : { text: source.text, refused: 'the laid-out file mills to a different program or names different imports' }
}

// format source text. Tolerant: if it does not parse, or its layout cannot be proven to mean the same, the original
// text is returned unchanged.
export function format(source: { file: string; text: string }, options: FormatOptions = {}): string {
  return formatReport(source, options).text
}
