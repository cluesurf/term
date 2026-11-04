// Longhand Term to lean Term, mechanically (self-hosting-0012, note/project/term/self-host/03-lean.md H1).
//
// WHY. Lean has been proven on one data DSL and never on ordinary code. Every lean defect so far was found by a real
// file held against another implementation, so the way to harden it is a CORPUS: convert every longhand file that
// exists and require the two spellings to compile identically (`pnpm term:lean-equal`). This is the converter that
// produces the lean side.
//
// WHAT IT REWRITES, and nothing else. Each rule drops a head the POSITION already implies (note/project/term/mill/lean.md):
//
//   text   `text <x>` in a value position                 ->  `<x>`
//   read   `read x` in a value position, x one plain word  ->  `x`        (a path keeps its `read`: lean-0019)
//   back   `send back, V`                                  ->  `back V`
//   call   `call f` with at least one argument             ->  `f ...`    (f not a reserved head)
//   bind   `bind k, V` under a call                        ->  `k V`      (k not a reserved head)
//   arm    `hook hold` / `hook miss` under a `fork`        ->  `hold` / `miss`   (lean-0022)
//   walk   `walk list, S` / `hook next` / take, body       ->  `walk S` / take, body   (lean-0023)
//
// It NEVER guesses. A rule fires only on the exact longhand shape it names, a group carrying comments is never
// unwrapped into a bare word (the comment would have nowhere to go), and whole subtrees whose heads are not code are
// left alone: imports, docks, signatures, templates and proofs. So the output is a SAFE lean, sometimes a little
// longer than a person would write. Whether it is also a CORRECT lean is not this file's claim: that is what the
// equivalence gate decides, file by file, against the compiler.
//
// The output is printed by the formatter (`formatTree`), which keeps every comment and lays a group on one line only
// when that line re-parses to the same tree.
//
//   pnpm term:lean-convert <file.tree>             print the lean form and the rule counts
//   pnpm term:lean-convert <file.tree> --commit    rewrite the file in place

import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, NameNode, RootNode } from '@term/make/code/parser/narrow'
import { formatTree } from '@term/make/code/format/format'
import { isDataFile } from '@term/make/code/compile/host'

export type Rule = 'text' | 'read' | 'back' | 'call' | 'bind' | 'arm' | 'walk'

export type Converted = {
  ok: boolean
  text: string
  count: Record<Rule, number>
  reason?: string
}

// Every head the language reserves in any position, from note/project/term/mill/lean.md "The vocabulary that stays" plus the arm,
// mode and literal words. A reserved word never becomes a bare call head or a label, because a bare one already means
// something else there.
const RESERVED = new Set(
  `load form task host hook bind bear deck dock note save test tell hold suit mask wear book kink lace cast tune view
   rule roll beam slot call head take like mark wait risk hide fold tag link case bond rein send back fork walk turn
   halt bust rest free move read make fuse loan code text term meet true false void list size miss next step fall
   else have must down show find name site base tree seed`
    .split(/\s+/)
    .filter(Boolean),
)

// Subtrees that are not ordinary code and are never touched: imports and native docks, the parts of a signature,
// templates (expanded before any mill runs), proofs, and metadata.
const OPAQUE = new Set([
  'load', 'dock', 'bear', 'deck', 'take', 'like', 'head', 'note', 'mark', 'tag', 'hide', 'fold', 'tree', 'fuse',
  'rule', 'hold', 'have', 'must', 'down', 'link', 'slot', 'beam', 'view', 'tell', 'kink', 'lace', 'risk', 'mask',
  'wear', 'suit', 'tune', 'book', 'cast', 'roll', 'code', 'term', 'meet', 'loan',
])

// heads whose children, after the head's own name, are STATEMENTS
const BODY = new Set(['task', 'test', 'hold', 'miss', 'case'])

// the `bind` rule is off by default, `--labels` turns it on (see the rule)
const LABELS = process.argv.includes('--labels')

// a call's own modifiers: present under a call, never an argument (lean-0030)
const MODIFIER = new Set(['wait', 'halt', 'like', 'link', 'hook'])

type Ctx = 'value' | 'statement' | 'other'

// THE PARSE SHAPE THIS RESTS ON: a word after a head is not a bare name node but a GROUP holding one name, a leaf.
// `send back` is group(name send, group(name back)), and `call join` is group(name call, group(name join), ...). So a
// word is read through a leaf group, and a word promoted to a head is the name node INSIDE it.
function nameNode(node: Node | undefined): NameNode | undefined {
  if (!node) {
    return undefined
  }

  if (node.kind === 'name') {
    return node
  }

  if (node.kind === 'group' && node.nodes.length === 1 && node.nodes[0]!.kind === 'name') {
    return node.nodes[0] as NameNode
  }

  return undefined
}

// a word spelled in plain chunks, as text, or undefined
function word(node: Node | undefined): string | undefined {
  const name = nameNode(node)

  if (!name || !name.parts.every(part => part.kind === 'chunk')) {
    return undefined
  }

  return name.parts.map(part => (part.kind === 'chunk' ? part.text : '')).join('')
}

function headOf(node: Node | undefined): string | undefined {
  return node && node.kind === 'group' ? word(node.nodes[0]) : undefined
}

// a word that can stand alone as a value or a label: lowercase kebab, and NOT a reserved head. `read term` keeps its
// `read`, because a bare `term` is the `term` keyword (found by lean-equal on home.tree, where `is-unequal term, <>`
// became `"" != ""`)
function plainWord(text: string | undefined): boolean {
  return text !== undefined && /^[a-z][a-z0-9-]*$/.test(text) && !RESERVED.has(text)
}

// a callee may be a path (`out/push`, `crypto/create-hash`): its FIRST segment decides whether it is reserved
function calleeOk(text: string | undefined): boolean {
  if (text === undefined || !/^[a-z][a-z0-9-]*(\/[a-z0-9-]+)*$/.test(text)) {
    return false
  }

  return !RESERVED.has(text.split('/')[0]!)
}

// the name node a word promotes to, as a group's head
function promoted(node: Node): NameNode {
  return nameNode(node)!
}

function group(from: GroupNode, nodes: GroupNode['nodes']): GroupNode {
  return { ...from, nodes }
}

class Converter {
  count: Record<Rule, number> = { text: 0, read: 0, back: 0, call: 0, bind: 0, arm: 0, walk: 0 }

  // keep every `text <...>`: set when dropping them would turn a code file into a DATA file (see toLean)
  constructor(readonly keepText = false) {}

  node(node: Node, ctx: Ctx): GroupNode['nodes'][number] {
    if (node.kind !== 'group') {
      return node as GroupNode['nodes'][number]
    }

    return this.group(node, ctx)
  }

  group(g: GroupNode, ctx: Ctx): GroupNode['nodes'][number] {
    let head = headOf(g)

    if (head !== undefined && OPAQUE.has(head)) {
      return g
    }

    const bare = !(g.comments?.length)

    // text: `text <x>` -> `<x>`
    if (!this.keepText && ctx === 'value' && head === 'text' && g.nodes.length === 2 && g.nodes[1]!.kind === 'text' && bare) {
      this.count.text++
      return g.nodes[1]!
    }

    // read: `read x` -> `x`, a single plain word only
    if (ctx === 'value' && head === 'read' && g.nodes.length === 2 && plainWord(word(g.nodes[1])) && bare) {
      this.count.read++
      return g.nodes[1]!
    }

    // back: `send back, V` -> `back V`
    if (head === 'send' && word(g.nodes[1]) === 'back' && g.nodes.length > 2) {
      this.count.back++
      g = group(g, [promoted(g.nodes[1]!), ...g.nodes.slice(2)])
      head = 'back'
    }

    // call: `call f` with an argument -> `f ...`
    if (head === 'call' && g.nodes.length > 2 && calleeOk(word(g.nodes[1]))) {
      // a `bind` is not an argument here: the mill reads a bare head as a call only with at least one PLAIN
      // argument, so `call is-minimum / bind a, x / bind b, y` keeps its `call` (log.tree lost both, and its
      // task its return value, when it was dropped)
      const args = g.nodes
        .slice(2)
        .filter(kid => !MODIFIER.has(headOf(kid) ?? '') && headOf(kid) !== 'bind')

      if (args.length > 0 && !g.nodes.slice(2).some(kid => headOf(kid) === 'hook')) {
        this.count.call++
        g = group(g, [promoted(g.nodes[1]!), ...g.nodes.slice(2)])
        head = word(g.nodes[0])
      }
    }

    const callLike = head !== undefined && head !== 'call' && !RESERVED.has(head.split('/')[0]!)

    // bind: `bind k, V` under a call -> `k V`. OFF unless asked: whether a label is legal depends on the callee
    // having a signature, which a converter reading one file cannot know. On a receiver method (`call push /
    // bind list, xs / bind item, x`) a `bind` is documentation, and the same label as a property head is refused
    // by design, so converting it turned 9 of zone's files into errors.
    if (LABELS && (callLike || head === 'call')) {
      g = group(
        g,
        g.nodes.map((kid, i) => {
          if (i === 0 || kid.kind !== 'group' || headOf(kid) !== 'bind' || kid.nodes.length !== 3) {
            return kid
          }

          const label = word(kid.nodes[1])

          if (!plainWord(label) || RESERVED.has(label!)) {
            return kid
          }

          this.count.bind++
          return group(kid, [promoted(kid.nodes[1]!), kid.nodes[2]!])
        }),
      )
    }

    // walk: `walk list, S` / `hook next` / take + body -> `walk S` / take + body
    if (head === 'walk') {
      return this.walk(g)
    }

    // arm: `hook hold` / `hook miss` under a fork -> `hold` / `miss`
    if (head === 'fork') {
      return this.fork(g)
    }

    return group(g, g.nodes.map((kid, i) => (i === 0 ? kid : this.node(kid, this.childCtx(head, g, i)))))
  }

  childCtx(head: string | undefined, g: GroupNode, i: number): Ctx {
    if (head === undefined) {
      return 'other'
    }

    if (BODY.has(head)) {
      return 'statement'
    }

    switch (head) {
      case 'hook': {
        const name = word(g.nodes[1])
        return name === 'test' ? 'value' : name === undefined ? 'other' : 'statement'
      }
      case 'save':
      case 'host':
      case 'bind':
        return i >= 2 ? 'value' : 'other'
      case 'back':
      case 'send':
      case 'make':
      case 'call':
        return 'value'
      case 'form':
        return 'other'
    }

    return RESERVED.has(head.split('/')[0]!) ? 'other' : 'value'
  }

  // a fork's own children: its mode word, its condition (a value) and its arms (bodies)
  fork(g: GroupNode): GroupNode {
    return group(
      g,
      g.nodes.map((kid, i) => {
        if (i === 0 || kid.kind !== 'group') {
          return kid
        }

        const head = headOf(kid)

        if (head === 'hook') {
          const name = word(kid.nodes[1])

          if ((name === 'hold' || name === 'miss') && !(kid.comments?.length)) {
            this.count.arm++
            return this.body(group(kid, [promoted(kid.nodes[1]!), ...kid.nodes.slice(2)]), 1)
          }

          return this.body(kid, 2, name === 'test')
        }

        if (head === 'case') {
          return this.body(kid, 2)
        }

        return this.node(kid, 'value')
      }),
    )
  }

  // a body: children from `from` on are statements, except a `hook test` whose first one is its condition
  body(g: GroupNode, from: number, test = false): GroupNode {
    return group(
      g,
      g.nodes.map((kid, i) => {
        if (i < from) {
          return kid
        }

        return this.node(kid, test && i === from ? 'value' : 'statement')
      }),
    )
  }

  walk(g: GroupNode): GroupNode {
    const [, mode, sequence, ...rest] = g.nodes
    const next = rest.length === 1 ? rest[0] : undefined

    if (
      word(mode) === 'list' &&
      sequence !== undefined &&
      next?.kind === 'group' &&
      headOf(next) === 'hook' &&
      word(next.nodes[1]) === 'next' &&
      !(next.comments?.length)
    ) {
      const seq = this.node(sequence, 'value')
      const seqWord = word(seq as Node)

      // a sequence spelled with a mode's own name keeps the mode, which is how lean-0023 tells the two apart
      if (seqWord !== 'list' && seqWord !== 'size' && seqWord !== 'test') {
        this.count.walk++

        return group(g, [
          g.nodes[0]!,
          seq,
          ...next.nodes.slice(2).map(kid => this.node(kid, headOf(kid) === 'take' ? 'other' : 'statement')),
        ])
      }
    }

    // any other walk: its bounds are values and its `hook` children are bodies
    return group(
      g,
      g.nodes.map((kid, i) => {
        if (i === 0 || kid.kind !== 'group') {
          return kid
        }

        if (headOf(kid) === 'hook') {
          return this.body(kid, 2, word(kid.nodes[1]) === 'test')
        }

        return this.node(kid, 'value')
      }),
    )
  }

  // one top-level group, and whether any rule fired inside it
  top(g: GroupNode): { node: GroupNode; changed: boolean } {
    const before = Object.values(this.count).reduce((sum, n) => sum + n, 0)
    const out = this.group(g, 'other')
    const after = Object.values(this.count).reduce((sum, n) => sum + n, 0)

    return { node: out.kind === 'group' ? out : g, changed: after > before }
  }
}

// heads whose children are a BODY and read badly collapsed onto one line, beyond the formatter's own set: a fork's
// arms once the `hook` is gone, and an exception handler. `halt take, take(error), log-fail(...)` is the same tree as
// the stacked form and nobody would write it.
const STACK = new Set(['hold', 'miss', 'halt'])

// the first source line (0-based) a top-level group occupies, its leading comments included
function startLine(g: GroupNode): number | undefined {
  const comment = g.comments?.[0]?.span.start.line
  const head = g.nodes[0]
  const token =
    head?.kind === 'name'
      ? head.parts.find(part => part.kind === 'chunk')
      : head && 'span' in head
        ? head
        : undefined
  const line = token && 'span' in token ? token.span.start.line : undefined

  return comment ?? line
}

// THE OUTPUT KEEPS WHAT IT DID NOT CHANGE. A top-level group no rule fired in is copied from the source exactly as
// written, so a converted file's diff is the lines lean changed and nothing else: no formatter opinion on a `dock`
// block, a signature, or a comment. Only a group with a rewrite inside it is printed by the formatter, which is
// what guarantees that group re-reads as the tree the rules built.
//
// IT NEVER TURNS CODE INTO DATA. A file whose top level is only `host` constants is CODE while each value says
// `text <...>`, and becomes a DATA file (the content rule in compile/host.ts, `isDataFile`) the moment those heads
// go, which compiles to a JSON module instead: the stdlib's eight `native/*/shared.tree` files did exactly that
// (`pnpm term:lean-equal`, 2026-10-02). Where no role says otherwise the content rule is what a build applies, so the
// conversion runs again with every `text` kept, and if the file would still flip it is left as it is.
export function toLean(source: { file: string; text: string }): Converted {
  const first = convert(source, false)

  if (!first.ok || isDataFile(source) || !isDataFile({ file: source.file, text: first.text })) {
    return first
  }

  const kept = convert(source, true)

  if (kept.ok && !isDataFile({ file: source.file, text: kept.text })) {
    return kept
  }

  return { ok: true, text: source.text, count: new Converter().count }
}

function convert(source: { file: string; text: string }, keepText: boolean): Converted {
  const parsed = parse(source)
  const converter = new Converter(keepText)

  if (!parsed.ok) {
    return { ok: false, text: source.text, count: converter.count, reason: 'does not parse' }
  }

  const lines = source.text.split('\n')
  const groups = parsed.tree.nodes
  const starts = groups.map(startLine)

  // without a line for every group the source cannot be sliced, so the whole file goes through the formatter
  if (starts.some(line => line === undefined)) {
    const tree = { ...parsed.tree, nodes: groups.map(g => converter.top(g).node) }
    return { ok: true, text: formatTree(tree, { wrap: false, stack: STACK }), count: converter.count }
  }

  const parts: string[] = []

  groups.forEach((g, i) => {
    const { node, changed } = converter.top(g)
    // span lines are 0-based
    const from = starts[i]!
    const to = i + 1 < groups.length ? starts[i + 1]! : lines.length

    if (changed) {
      parts.push(formatTree({ kind: 'root', nodes: [node] }, { wrap: false, stack: STACK }).trimEnd())
    } else {
      parts.push(lines.slice(from, to).join('\n').trimEnd())
    }
  })

  return { ok: true, text: `${parts.join('\n\n')}\n`, count: converter.count }
}

function main(): void {
  const argv = process.argv.slice(2)
  const file = argv.find(a => !a.startsWith('--'))

  if (!file) {
    console.error('usage: pnpm term:lean-convert <file.tree> [--commit]')
    process.exit(2)
  }

  const text = readFileSync(file, 'utf8')
  const out = toLean({ file, text })

  if (!out.ok) {
    console.error(`term lean-convert: ${file} ${out.reason}`)
    process.exit(1)
  }

  const counts = Object.entries(out.count)
    .filter(([, n]) => n > 0)
    .map(([rule, n]) => `${rule} ${n}`)
    .join(', ')

  if (argv.includes('--commit')) {
    writeFileSync(file, out.text)
    console.error(`term lean-convert: wrote ${file} (${counts || 'no change'})`)
    return
  }

  process.stdout.write(out.text)
  console.error(`term lean-convert: ${counts || 'no change'}, ${text.split('\n').length} -> ${out.text.split('\n').length} lines`)
}

if (process.argv[1]?.endsWith('lean-convert.ts')) {
  main()
}
