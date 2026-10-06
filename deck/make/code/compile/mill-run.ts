// The mill executor (mill-self-hosting-0004): read a `mine` grammar into rules, run it against a parse tree to
// fill sites, and run its `mint` to build the target values — the machinery that makes a dialect cost a grammar
// file instead of a hand-written reader. Proven on the host role against compile/host.ts on every fixture
// (test/compile/mill-run.ts).
//
// The mine dialect (deck/mill/code/tree/mill/mine.tree is its own grammar):
//   mine term, term <w>   match a group headed <w>; inner rules consume its remaining nodes in order
//   mine term / site s    consume one word (a bare name, or a group wrapping one) into site s
//   mine text / site s    consume a text literal
//   mine code / site s    consume a number literal (integer, decimal or radix), tagged with which it was
//   mine path / site s    consume a path or glob word (`@/book/**/*.tree` is one word to the parser)
//   mine node             consume any one node, capturing nothing (the skip for a mixed file)
//   mine word / site s    consume a word with NOTHING under it (`mine term` takes a group's head and drops
//                         whatever it holds, which in value position turns a call into a name)
//   mine maybe [r]        the rule, or nothing
//   mine list [r]         the rule, zero or more times
//   mine any [r...]       the first alternative that matches
//   mine form, like <m> / site s   match the named rule against the current node, capture into s
//
// The mint dialect: one mint per mine. `case <field> [, mint <sub>]` maps the site's captures (each minted
// through <sub> when named); `hook make / make <form> / bind f, read <case>` builds a record. A mint with no
// make passes through: a single matched case's value rides out as it is (a literal keeps its own data kind, a
// word rides as its text), which is what a pure alternation (host-entry, host-scalar) wants.
//
// The executor is compile/mill-running.tree (self-hosting, 2026-10-06). This face keeps the shapes the bridge and
// the deck readers hold: a missing word or span is `undefined`, the lean rules are a `Set`, and a minted form's fields
// are a `Record`. A capture and a match are the port's own, field for field what they were. A grammar is the port's
// too, and nothing outside reads its rules, whose `maybe` is spelled `optional` there.

import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import type { Span } from '@term/make/code/parser/diagnostic'
import * as port from '@term/make/code/compile/mill-running'

// a captured value: a word or literal, or a nested rule match to be minted. Each carries the SPAN of the node it
// came from, so a consumer's diagnostic points at the line in the file, and the CST `node` itself, so a built AST
// node can point back at the exact surface syntax it was read from (mint-bridge-0001). An integer literal is a
// number while that is exact, and a bigint read from its own text past 2^53, where the parsed number has already
// rounded to a different integer.
export type MillCapture =
  | { kind: 'word'; value: string; span?: Span; node?: Node }
  | { kind: 'text'; value: string; span?: Span; node?: Node }
  | {
      kind: 'number'
      // a bigint only for an integer past 2^53, where a number would round to a different value
      value: number | bigint
      decimal: boolean
      span?: Span
      node?: Node
    }
  | {
      kind: 'match'
      rule: string
      match: MillMatch
      span?: Span
      node?: Node
    }

// one rule's fill: site name -> the captures that landed there, in order
export type MillMatch = Map<string, MillCapture[]>

export type MineRule = port.MineRule

export type MineGrammar = Map<string, MineRule[]>

export const ZERO_SPAN: Span = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 },
}

const unbox = <T>(value: port.Maybe<T>): T | undefined => (value.form === 'some' ? value.value : undefined)

// The EXTENT a node covers: head through the last child, so a diagnostic underlines the whole construct and a
// source-slice autofix captures the exact surface syntax. This is the span every AST node carries (mint-bridge-0001).
//
// Distinct from `spanOfNode` below, which answers a different question: where to point a caret. Keep both.
export function spanOfWhole(node: Node): Span {
  return port.spanOfWhole(node as never)
}

// the source span a node covers (its first token's), so a consumer's diagnostic can point at the line
export function spanOfNode(node: Node | undefined): Span | undefined {
  return node ? unbox(port.spanOfNode(node as never)) : undefined
}

// exported for reuse by other tree-CST-reading compilers (feed-mill.ts's grammar reader among them) — these four
// are generic ".tree node -> word/phrase/text" readers, nothing here is mill's own rule vocabulary specifically
export function wordOf(node: Node | undefined): string | undefined {
  return node ? unbox(port.wordOf(node as never)) : undefined
}

// the full word chain a node denotes: a multi-word value parses as nested heads (`vitest run` is
// vitest > run), so a phrase reconstructs by walking head plus terms recursively, space-joined
export function phraseOf(node: Node | undefined): string | undefined {
  return node ? unbox(port.phraseOf(node as never)) : undefined
}

export function headWord(group: GroupNode): string | undefined {
  return unbox(port.headWord(group as never))
}

// the VALUE of a text literal: its chunks, with the escape sequences resolved. A reader that skips the
// unescaping gets `\n` as two characters, which is a different string from the one the source wrote.
export function textOf(node: Node): string {
  return port.textOf(node as never)
}

export function readMineGrammar(tree: RootNode): MineGrammar {
  return port.readMineGrammar(tree as never)
}

// The `mine` rules that carry a `mark lean` child: the constructs that take the lean surface, where a bare-head
// argument becomes a NAMED argument in a file whose role is marked lean. Declared per rule and read here, never
// derived from the rule's shape. The shape-derived version ("a rule with a `bind` site") was measured on
// 2026-09-12 and refused: thirty rules have one, and at least seven must never take labels. note/term/lean.md.
export function readLeanRules(tree: RootNode): Set<string> {
  return new Set(port.readLeanRules(tree as never))
}

// run a grammar's start rule over a whole parse tree (the root's groups)
export function runMine(
  grammar: MineGrammar,
  start: string,
  tree: RootNode,
): { ok: true; match: MillMatch } | { ok: false; at?: Node } {
  const run = port.runMine(grammar, start, tree as never)

  if (run.ok) {
    return { ok: true, match: run.match as MillMatch }
  }

  return run.started ? { ok: false, at: run.at as Node | undefined } : { ok: false }
}

// ---- the mint grammar ----

export type MintCase = port.MintCase
export type MintBind = port.MintBind
export type MintMake = port.MintMake
export type Mint = port.MintRule

export type MintGrammar = Map<string, Mint>

export function readMintGrammar(tree: RootNode): MintGrammar {
  return port.readMintGrammar(tree as never)
}

// ---- minting ----

// A minted value keeps the CST node it was built from (and that node's extent), so the bridge that turns these
// into compiler AST nodes can carry an exact span onto every one of them.
export type Minted =
  | { kind: 'word'; value: string; span?: Span; node?: Node }
  | { kind: 'text'; value: string; span?: Span; node?: Node }
  | {
      kind: 'number'
      value: number | bigint
      decimal: boolean
      span?: Span
      node?: Node
    }
  | {
      kind: 'form'
      form: string
      fields: Record<string, Minted[]>
      span?: Span
      node?: Node
    }

// a minted form's fields as the `Record` the bridge reads. The port hands back the same list wherever minting was
// remembered, so each list and form is converted once and shared as it was
function mintedOf(values: port.Minted[], seen: WeakMap<object, unknown>): Minted[] {
  const known = seen.get(values)

  if (known) {
    return known as Minted[]
  }

  const out = values.map(value => mintedValue(value, seen))
  seen.set(values, out)

  return out
}

function mintedValue(value: port.Minted, seen: WeakMap<object, unknown>): Minted {
  if (value.kind !== 'form') {
    return value as Minted
  }

  const known = seen.get(value)

  if (known) {
    return known as Minted
  }

  const fields: Record<string, Minted[]> = {}

  for (const [name, list] of value.fields) {
    fields[name] = mintedOf(list, seen)
  }

  const out: Minted = { kind: 'form', form: value.form, fields, span: value.span, node: value.node as Node | undefined }
  seen.set(value, out)

  return out
}

export function runMint(
  mints: MintGrammar,
  name: string,
  match: MillMatch,
  // the CST node this match was read from: it becomes the built form's own node, so the bridge can span it
  node?: Node,
): Minted[] {
  const from: port.Maybe<never> = node ? { form: 'some', value: node as never } : { form: 'none' }

  return mintedOf(port.runMint(mints, name, match as never, from), new WeakMap())
}
