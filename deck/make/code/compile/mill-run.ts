// The mill executor (mill-self-hosting-0004): read a `mine` grammar into rules, run it against a parse tree to fill
// sites, and run its `mint` to build the target values, so a dialect costs a grammar file instead of a hand-written
// reader. The mine and mint dialects are deck/mill/code/tree/mill/mine.tree's, and the executor is
// compile/mill-running.tree. This face keeps the shapes the deck readers and the tests hold: a missing word or span is
// `undefined`, the lean rules are a `Set`, and a minted form's fields are a `Record`. A capture and a match are the
// port's own. A grammar is the port's too, whose `maybe` is spelled `optional` there.

import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import type { Span } from '@term/make/code/parser/diagnostic'
import * as port from '@term/make/code/compile/mill-running'
import * as lowering from '@term/make/code/compile/find-lower'

type Placed = { span?: Span; node?: Node; at?: number; within?: number }

// a captured value: a word or literal, or a nested rule match to be minted. Each carries the SPAN and the CST `node` it
// came from (mint-bridge-0001). An integer literal is a number while that is exact, and a bigint read from its own text
// past 2^53. `at` is the node's index among the nodes the mine enumerated it from, which the bridge orders by (decision
// 033 section 3), and `within` the `at` of a callee's parentheses it was enumerated inside (mill-running.tree `mill-capture`)
export type MillCapture =
  | ({ kind: 'word'; value: string } & Placed)
  | ({ kind: 'text'; value: string } & Placed)
  | ({ kind: 'number'; value: number | bigint; decimal: boolean } & Placed)
  | ({ kind: 'match'; rule: string; match: MillMatch } & Placed)

// one rule's fill: site name -> the captures that landed there, in order
export type MillMatch = Map<string, MillCapture[]>

export type MineRule = port.MineRule

export type MineGrammar = Map<string, MineRule[]>

export const ZERO_SPAN: Span = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 },
}

const unbox = <T>(value: port.Maybe<T>): T | undefined => (value.form === 'some' ? value.value : undefined)

// The EXTENT a node covers, head through the last child: the span every AST node carries (mint-bridge-0001). Distinct
// from `spanOfNode`, which says where to point a caret
export const spanOfWhole = (node: Node): Span => port.spanOfWhole(node as never)

// the source span a node covers (its first token's), so a consumer's diagnostic can point at the line
export const spanOfNode = (node: Node | undefined): Span | undefined => (node ? unbox(port.spanOfNode(node as never)) : undefined)

// generic ".tree node -> word/phrase/text" readers, for any tree-CST-reading compiler (feed-mill.ts's grammar reader)
export const wordOf = (node: Node | undefined): string | undefined => (node ? unbox(port.wordOf(node as never)) : undefined)

// the full word chain a node denotes: `vitest run` parses as vitest > run, so a phrase is head plus terms, space-joined
export const phraseOf = (node: Node | undefined): string | undefined => (node ? unbox(port.phraseOf(node as never)) : undefined)

export const headWord = (group: GroupNode): string | undefined => unbox(port.headWord(group as never))

// the VALUE of a text literal: its chunks, with the escape sequences resolved
export const textOf = (node: Node): string => port.textOf(node as never)

export const readMineGrammar = (tree: RootNode): MineGrammar => port.readMineGrammar(tree as never)

// The `mine` rules that carry a `mark lean` child: the constructs that take the lean surface, declared per rule and
// never derived from the rule's shape (note/project/term/mill/lean.md)
export const readLeanRules = (tree: RootNode): Set<string> => new Set(port.readLeanRules(tree as never))

// run a grammar's start rule over a whole parse tree (the root's groups)
export function runMine(grammar: MineGrammar, start: string, tree: RootNode): { ok: true; match: MillMatch } | { ok: false; at?: Node } {
  const run = port.runMine(grammar, start, tree as never)

  if (run.ok) {
    return { ok: true, match: run.match as MillMatch }
  }

  return run.started ? { ok: false, at: run.at as Node | undefined } : { ok: false }
}

export type MintCase = port.MintCase
export type MintBind = port.MintBind
export type MintMake = port.MintMake
export type Mint = port.MintRule

export type MintGrammar = Map<string, Mint>

export const readMintGrammar = (tree: RootNode): MintGrammar => port.readMintGrammar(tree as never)

// A minted value keeps the CST node it was built from (and that node's extent), so the bridge can span every node
export type Minted =
  | ({ kind: 'word'; value: string } & Placed)
  | ({ kind: 'text'; value: string } & Placed)
  | ({ kind: 'number'; value: number | bigint; decimal: boolean } & Placed)
  | ({ kind: 'form'; form: string; fields: Record<string, Minted[]> } & Placed)

// a minted form's fields as the `Record` the readers take
function mintedValue(value: port.Minted): Minted {
  if (value.kind !== 'form') {
    return value as Minted
  }

  const fields: Record<string, Minted[]> = {}

  for (const [name, list] of value.fields) {
    fields[name] = list.map(mintedValue)
  }

  return {
    kind: 'form',
    form: value.form,
    fields,
    span: value.span,
    node: value.node as Node | undefined,
    ...(value.at === undefined ? {} : { at: value.at }),
    ...(value.within === undefined ? {} : { within: value.within }),
  }
}

const maybeOf = <T>(value: T | undefined): port.Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })

// a node is some when it is there at all, as the original asked it (`node ? ... : ...`)
const nodeOf = (node: Node | undefined): port.Maybe<never> => (node ? { form: 'some', value: node as never } : { form: 'none' })

// `node` is the CST node this match was read from and `at` its index among the nodes the mine enumerated it from: the
// built form's own node and at
export const runMint = (mints: MintGrammar, name: string, match: MillMatch, node?: Node, at?: number): Minted[] =>
  port.runMint(mints, name, match as never, nodeOf(node), maybeOf(at)).map(mintedValue)

// what the lowering of a find could not do: a code and a message, at the span of the find (decision 005)
export type FindProblem = { code: string; message: string; span?: Span }

// `runMint` for the CODE role, with every `find` in what it minted lowered to the base forms the bridge builds
// (compile/find-lower.tree `lower-finds`, note/project/term/find/decision/005)
export function runCodeMint(mints: MintGrammar, name: string, match: MillMatch, node?: Node, at?: number): { values: Minted[]; problems: FindProblem[] } {
  const lowered = lowering.lowerFinds(port.runMint(mints, name, match as never, nodeOf(node), maybeOf(at)) as never)

  return { values: (lowered.values as port.Minted[]).map(mintedValue), problems: lowered.problems as FindProblem[] }
}
