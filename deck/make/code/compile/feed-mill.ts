// The feed mill compiler: reads a format grammar's mine.tree (deck/mill/code/text, blob) and GENERATES real Term (.tree) source
// text implementing the reader — compiled ahead of time through the ordinary parse/mill/check/emit pipeline onto
// every backend, not interpreted at parse time. It reads raw BYTES or CHARACTERS of an arbitrary format (hex digits,
// gzip, JSON, ...) against `@term/mill/feed.tree`'s `feed-cursor`/`text-cursor` primitives. See
// note/term/project/feed-compiler.md.
//
// The grammar reader, the checks over it, the expression printer and the code generator are
// compile/feed-compile.tree (self-hosting, 2026-10-06). This face keeps the types callers hold, renames the one rule
// tag Term cannot spell (the port's `optional` is the original's `maybe`: a case named `maybe` there would take the
// stdlib's `maybe`), answers `undefined` where the port answers an empty substrate, and keeps `feedMineLoads`, which
// finds a grammar's top-level group boundaries through parser/stream.ts `walkGroups`.

import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import { walkGroups } from '@term/make/code/parser/stream'
import { headWord } from './mill-run'
import * as port from '@term/make/code/compile/feed-compile'

// ---- the rule objects ----

export type FeedMineRule =
  // `mine list` with an optional `bind count, read table-count`: a repetition, COUNT-DIRECTED when it says how
  // many. Without the count it reads until the input ends.
  | { kind: 'list'; children: FeedMineRule[]; count?: Node }
  | { kind: 'any'; children: FeedMineRule[]; send?: string }
  | { kind: 'range'; base: string; head: string }
  // `mine form, form row` with `bind separator, share separator` children: a reference to another rule, with the
  // ARGUMENTS that rule's own `start` parameters receive
  | { kind: 'form'; name: string; send?: string; args?: FeedMineArg[] }
  | { kind: 'value'; expr: GroupNode }
  | { kind: 'send'; name: string }
  | { kind: 'byte'; literal?: number; send?: string }
  // `mine char, text <">` / `mine char, code 0x0020`: exactly one character, by literal or by code point
  | { kind: 'char'; literal: number; send?: string }
  // `mine text, text <true>`: a fixed multi-character literal, matched in order
  | { kind: 'text'; literal: string; send?: string }
  // `mine not / mine any / mine char ...`: negative lookahead
  | { kind: 'not'; codes: number[] }
  // `mine mark / bind width, code 4 / mine form, form hex-digit`: the nested rule exactly `width` times
  | { kind: 'mark'; width: number; children: FeedMineRule[]; send?: string }
  | { kind: 'int'; width: number; order: 'big' | 'little'; sign: 'signed' | 'unsigned'; send?: string }
  | { kind: 'bytes'; width: GroupNode; send?: string }
  | { kind: 'maybe'; test?: GroupNode; children: FeedMineRule[]; send?: string }
  | { kind: 'until'; terminator: number; send?: string }
  | { kind: 'let'; name: string; expr: GroupNode }
  // `bind value / mine text / <rules>`: a SPAN CAPTURE, the text its children consumed
  | { kind: 'span'; children: FeedMineRule[]; send: string }
  // `start separator, share <,>`: a rule PARAMETER, with an optional default
  | { kind: 'start'; name: string; fall?: Node }
  // `check bitwise-and / bind start, share value-format / bind front, share 0x0001 / <body>`: a read gated on a
  // condition, which compiles as a `maybe` with that test
  | { kind: 'check'; op: string; base: Node; head: Node; children: FeedMineRule[] }

// an argument at a call: `bind separator, share separator`
export type FeedMineArg = { name: string; value: Node }

export type FeedMineGrammar = Map<string, FeedMineRule[]>

// the two cursor substrates every dialect in this package reads against (`02-cursor.md`)
export type Substrate = 'byte' | 'text'

// ---- the boundary: the one tag the port spells otherwise ----

type PortRule = port.FeedRule

function fromPort(rule: PortRule): FeedMineRule {
  const children = (rule as { children?: PortRule[] }).children

  if (rule.kind === 'optional') {
    return { ...rule, kind: 'maybe', children: rule.children.map(fromPort) } as FeedMineRule
  }

  return (children ? { ...rule, children: children.map(fromPort) } : rule) as FeedMineRule
}

function toPort(rule: FeedMineRule): PortRule {
  const children = (rule as { children?: FeedMineRule[] }).children

  if (rule.kind === 'maybe') {
    return { ...rule, kind: 'optional', children: rule.children.map(toPort) } as PortRule
  }

  return (children ? { ...rule, children: children.map(toPort) } : rule) as PortRule
}

function grammarToPort(grammar: FeedMineGrammar): Map<string, PortRule[]> {
  const out = new Map<string, PortRule[]>()

  for (const [name, rules] of grammar) {
    out.set(name, rules.map(toPort))
  }

  return out
}

// ---- reading and checking a grammar ----

export function readFeedMineGrammar(tree: RootNode): FeedMineGrammar {
  const out: FeedMineGrammar = new Map()

  for (const [name, rules] of port.readFeedMineGrammar(tree as never)) {
    out.set(name, rules.map(fromPort))
  }

  return out
}

// Which substrate a grammar reads: bytes or characters, INFERRED from the constructs it uses. A grammar that uses
// both, or neither, answers undefined rather than a guess.
export function feedMineSubstrate(grammar: FeedMineGrammar): Substrate | undefined {
  const substrate = port.feedMineSubstrate(grammarToPort(grammar))

  return substrate === '' ? undefined : (substrate as Substrate)
}

// The `load` blocks a grammar writes for itself, as source lines. THE PARSER FINDS THE BOUNDARIES: `walkGroups`
// says where each top-level group ends, and the raw lines of the ones headed `load` are taken from the source
// untouched. Counting indentation to find a block's extent would be a second reader of the grammar.
export function feedMineLoads(file: string, text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let at = 0

  walkGroups({ file, text }, result => {
    if (result.kind !== 'group') {
      return false
    }

    const span = lines.slice(at, at + result.lines)

    at += result.lines

    if (headWord(result.group) === 'load') {
      out.push(...span.map(line => line.replace(/\s+$/, '')))
    }

    return true
  })

  // a trailing blank so the generated file's own `load` blocks do not run into these
  return out.length > 0 ? [...out, ''] : out
}

// The rule NAMES a grammar refers to and never defines, sorted
export function feedMineUnknownRefs(grammar: FeedMineGrammar): string[] {
  return port.feedMineUnknownRefs(grammarToPort(grammar))
}

// The rules a grammar DECLARES with a body that read to nothing
export function feedMineDrops(tree: RootNode): string[] {
  return port.feedMineDrops(tree as never)
}

// The LEAF rules that read to nothing, anywhere in the grammar, each as a message naming the line
export function feedMineFaults(tree: RootNode): string[] {
  return port.feedMineFaults(tree as never)
}

// ---- printing an embedded Term expression node back to .tree source text ----

export function printNode(node: Node, depth = 0): string {
  return port.printNode(node as never, depth)
}

// ---- compiling a mine grammar to .tree source text ----

// The counters the code generator keeps while it works: how deep in a repetition and in a span it is. They were
// module variables, raised and lowered around each nested compile, so a compile that throws partway leaves them raised
// for every compile after it in the process. That is kept exactly, by holding one state for the module, until it is
// decided whether a throw should reset them.
const STATE = port.freshFeedState()

export function compileFeedMine(
  grammar: FeedMineGrammar,
  substrate: Substrate,
  cursorImportPath: string,
  extraImports: string[] = [],
): string {
  return port.compileFeedMine(grammarToPort(grammar), substrate, cursorImportPath, extraImports, STATE)
}
