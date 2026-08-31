// The mill executor (mill-self-hosting-0004): read a `mine` grammar into rules, run it against a parse tree to
// fill sites, and run its `mint` to build the target values — the machinery that makes a dialect cost a grammar
// file instead of a hand-written reader. Proven on the host role against compile/host.ts on every fixture
// (test/compile/mill-run.ts).
//
// The mine dialect (deck/mill/code/mill/mine.tree is its own grammar):
//   mine term, term <w>   match a group headed <w>; inner rules consume its remaining nodes in order
//   mine term / site s    consume one word (a bare name, or a group wrapping one) into site s
//   mine text / site s    consume a text literal
//   mine code / site s    consume a number literal (integer, decimal or radix), tagged with which it was
//   mine path / site s    consume a path or glob word (`@/book/**/*.tree` is one word to the parser)
//   mine node             consume any one node, capturing nothing (the skip for a mixed file)
//   mine maybe [r]        the rule, or nothing
//   mine list [r]         the rule, zero or more times
//   mine any [r...]       the first alternative that matches
//   mine form, like <m> / site s   match the named rule against the current node, capture into s
//
// The mint dialect: one mint per mine. `case <field> [, mint <sub>]` maps the site's captures (each minted
// through <sub> when named); `hook make / make <form> / bind f, read <case>` builds a record. A mint with no
// make passes through: a single matched case's value rides out as it is (a literal keeps its own data kind, a
// word rides as its text), which is what a pure alternation (host-entry, host-scalar) wants.

import type {
  GroupNode,
  Node,
  RootNode,
} from '@term/make/code/parser/tree'
import type { Span } from '@term/make/code/parser/diagnostic'
import { unescapeText } from '@term/make/code/compile/surface'

// a captured value: a word or literal, or a nested rule match to be minted. Each carries the SPAN of the node it
// came from, so a consumer's diagnostic (a manifest error, a lockfile error) points at the line in the file, and
// the CST `node` itself, so a built AST node can point back at the exact surface syntax it was read from. A span
// alone loses the shape, and the shape is what an accurate diagnostic needs (mint-bridge-0001).
export type MillCapture =
  | { kind: 'word'; value: string; span?: Span; node?: Node }
  | { kind: 'text'; value: string; span?: Span; node?: Node }
  | {
      kind: 'number'
      value: number
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

// ---- the mine grammar, read from its own parse tree ----

export type MineRule =
  | { kind: 'term'; word?: string; children: MineRule[]; site?: string }
  | { kind: 'text'; site?: string }
  | { kind: 'code'; site?: string }
  | { kind: 'path'; site?: string }
  | { kind: 'node' }
  | { kind: 'open'; children: MineRule[]; site?: string }
  | { kind: 'maybe'; children: MineRule[] }
  | { kind: 'list'; children: MineRule[] }
  | { kind: 'any'; children: MineRule[] }
  | { kind: 'form'; like: string; site?: string }

export type MineGrammar = Map<string, MineRule[]>


export const ZERO_SPAN: Span = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 },
}

// The EXTENT a node covers: head through the last child, so a diagnostic underlines the whole construct and a
// source-slice autofix captures the exact surface syntax. This is the span every AST node carries, and it is the
// one `compile/mill.ts` imports as its own `spanOf` — one implementation, so the hand-written mill and the
// executor can never drift on where a node begins and ends (mint-bridge-0001).
//
// Distinct from `spanOfNode` below, which answers a different question: where to point a caret. Keep both.
export function spanOfWhole(node: Node): Span {
  switch (node.kind) {
    case 'integer':
    case 'decimal':
    case 'radix':
      return node.token.span
    case 'name':

    case 'text': {
      const chunk = node.parts.find(p => p.kind === 'chunk')

      return chunk?.kind === 'chunk' ? chunk.token.span : ZERO_SPAN
    }

    case 'chunk':
      return node.token.span

    case 'group': {
      const head = node.nodes[0]

      if (!head) {
        return ZERO_SPAN
      }

      // span the whole construct, head through the last child, so diagnostics underline the full term and
      // source-slice autofixes (the linter) capture the exact surface syntax, not just the head keyword.
      const last = node.nodes[node.nodes.length - 1]!

      return { start: spanOfWhole(head).start, end: spanOfWhole(last).end }
    }

    default:
      return ZERO_SPAN
  }
}

// the source span a node covers (its first token's), so a consumer's diagnostic can point at the line
export function spanOfNode(node: Node | undefined): Span | undefined {
  if (!node) {
    return undefined
  }

  switch (node.kind) {
    case 'name':
    case 'text': {
      const part = node.parts[0]

      return part && 'token' in part ? part.token.span : undefined
    }
    case 'integer':
    case 'decimal':
    case 'radix':
      return node.token.span
    case 'group':
      return spanOfNode(node.nodes[0])
    default:
      return undefined
  }
}

// exported for reuse by other tree-CST-reading compilers (feed-mill.ts's grammar reader among them) — these four
// are generic ".tree node -> word/phrase/text" readers, nothing here is mill's own rule vocabulary specifically
export function wordOf(node: Node | undefined): string | undefined {
  if (!node) {
    return undefined
  }

  if (node.kind === 'name') {
    // an interpolation part renders as written (`{platform}` in a load path is part of the word)
    return node.parts
      .map(p =>
        p.kind === 'chunk'
          ? p.text
          : `{${p.group && p.group.nodes[0]?.kind === 'name' ? p.group.nodes[0].parts.map(q => (q.kind === 'chunk' ? q.text : '')).join('') : ''}}`,
      )
      .join('')
  }

  if (
    node.kind === 'group' &&
    node.nodes.length >= 1 &&
    node.nodes[0]?.kind === 'name'
  ) {
    return wordOf(node.nodes[0])
  }

  return undefined
}


// the full word chain a node denotes: a multi-word value parses as nested heads (`vitest run` is
// vitest > run), so a phrase reconstructs by walking head plus terms recursively, space-joined
export function phraseOf(node: Node | undefined): string | undefined {
  const head = wordOf(node)

  if (head === undefined || node?.kind !== 'group') {
    return head
  }

  const parts = [head]

  let cursor: Node | undefined = node.nodes[1]

  while (cursor && cursor.kind === 'group') {
    const next: string | undefined = wordOf(cursor)

    if (next === undefined) {
      break
    }

    parts.push(next)
    cursor = cursor.nodes[1]
  }

  return parts.join(' ')
}

export function headWord(group: GroupNode): string | undefined {
  return group.nodes[0]?.kind === 'name'
    ? wordOf(group.nodes[0])
    : undefined
}

// the VALUE of a text literal: its chunks, with the escape sequences resolved. A reader that skips the
// unescaping gets `\n` as two characters, which is a different string from the one the source wrote.
export function textOf(node: Node): string {
  return node.kind === 'text'
    ? unescapeText(
        node.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join(''),
      )
    : ''
}

// the site name a rule group carries (`site <name>` child)
function siteOf(group: GroupNode): string | undefined {
  for (const child of group.nodes) {
    if (child.kind === 'group' && headWord(child) === 'site') {
      return wordOf(child.nodes[1])
    }
  }

  return undefined
}

function readMineRule(group: GroupNode): MineRule | undefined {
  if (headWord(group) !== 'mine') {
    return undefined
  }

  const kindNode = group.nodes[1]
  const kind = wordOf(kindNode)
  const site = siteOf(group)
  const childRules = (): MineRule[] => {
    const rules: MineRule[] = []

    for (const child of group.nodes.slice(2)) {
      if (child.kind === 'group') {
        const rule = readMineRule(child)

        if (rule) {
          rules.push(rule)
        }
      }
    }

    return rules
  }

  switch (kind) {
    case 'term': {
      // `mine term, term <w>` carries the word under the second `term`; a bare `mine term` captures a word
      const wordGroup = group.nodes.find(
        (n, i): n is GroupNode =>
          i >= 2 && n.kind === 'group' && headWord(n) === 'term',
      )
      const word = wordGroup ? wordOf(wordGroup.nodes[1]) : undefined
      const children: MineRule[] = []

      for (const child of group.nodes.slice(2)) {
        if (
          child.kind === 'group' &&
          headWord(child) === 'mine'
        ) {
          const rule = readMineRule(child)

          if (rule) {
            children.push(rule)
          }
        }
      }

      // the word can also ride inside the term group's own children (`mine term, term host` puts nothing there,
      // but `term term` nesting under kindNode does): check the kind node's group for a nested word
      const nested =
        !word &&
        kindNode?.kind === 'group' &&
        kindNode.nodes.length > 1
          ? wordOf(kindNode.nodes[1])
          : undefined

      return { kind: 'term', word: word ?? nested, children, site }
    }
    case 'text':
      return { kind: 'text', site }
    case 'code':
      return { kind: 'code', site }
    case 'path':
      return { kind: 'path', site }
    case 'node':
      return { kind: 'node' }
    case 'open':
      // a group with ANY head word (a bare call spells the callee as the head): the word is captured at the
      // site, and the child rules run over the group's remaining nodes
      return { kind: 'open', children: childRules(), site }
    case 'maybe':
    // `mine case` in the dialect marks an optional part the mint later cases on: match-wise it is a maybe
    case 'case':
      return { kind: 'maybe', children: childRules() }
    case 'list':
      return { kind: 'list', children: childRules() }
    case 'any':
      return { kind: 'any', children: childRules() }
    case 'form': {
      // `mine form, like <name>`
      const like = group.nodes.find(
        (n): n is GroupNode =>
          n.kind === 'group' && headWord(n) === 'like',
      )
      const name = like ? wordOf(like.nodes[1]) : undefined

      return name ? { kind: 'form', like: name, site } : undefined
    }
    default:
      return undefined
  }
}

export function readMineGrammar(tree: RootNode): MineGrammar {
  const grammar: MineGrammar = new Map()

  for (const group of tree.nodes) {
    if (headWord(group) !== 'mine') {
      continue
    }

    const name = wordOf(group.nodes[1])

    if (!name) {
      continue
    }

    const rules: MineRule[] = []

    for (const child of group.nodes.slice(2)) {
      if (child.kind === 'group') {
        const rule = readMineRule(child)

        if (rule) {
          rules.push(rule)
        }
      }
    }

    grammar.set(name, rules)
  }

  return grammar
}

// ---- matching ----

// run one rule sequence against a node cursor. Returns the new cursor position, or undefined on no match.
function matchSequence(
  grammar: MineGrammar,
  rules: MineRule[],
  nodes: Node[],
  at: number,
  into: MillMatch,
): number | undefined {
  let cursor = at

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!
    const next = matchRule(grammar, rule, nodes, cursor, into)

    if (next === undefined) {
      // paren splice: `send back(false)` and `send back, false` are one tree in the language, but the paren
      // nests the value under `back`. A worded term rule facing a group headed by its own word matches its
      // child rules as a PREFIX of the group, then hands the group's leftover nodes to the REST of the sequence.
      const node = nodes[cursor]

      if (
        rule.kind === 'term' &&
        rule.word !== undefined &&
        node?.kind === 'group' &&
        headWord(node) === rule.word &&
        node.nodes.length > 1
      ) {
        const inner: MillMatch = new Map()
        const innerEnd = matchSequence(
          grammar,
          rule.children,
          node.nodes,
          1,
          inner,
        )

        if (innerEnd !== undefined) {
          const extras = node.nodes.slice(innerEnd)
          const spliced = [...extras, ...nodes.slice(cursor + 1)]
          const after: MillMatch = new Map()
          const end = matchSequence(
            grammar,
            rules.slice(i + 1),
            spliced,
            0,
            after,
          )

          if (end !== undefined && end >= extras.length) {
            capture(into, rule.site, {
              kind: 'word',
              value: rule.word,
              span: spanOfNode(node),
              node,
            })

            for (const trial of [inner, after]) {
              for (const [site, values] of trial) {
                for (const value of values) {
                  capture(into, site, value)
                }
              }
            }

            return cursor + 1 + (end - extras.length)
          }
        }
      }

      return undefined
    }

    cursor = next
  }

  return cursor
}

function capture(
  into: MillMatch,
  site: string | undefined,
  value: MillCapture,
): void {
  if (!site) {
    return
  }

  const list = into.get(site) ?? []
  list.push(value)
  into.set(site, list)
}

function matchRule(
  grammar: MineGrammar,
  rule: MineRule,
  nodes: Node[],
  at: number,
  into: MillMatch,
): number | undefined {
  const node = nodes[at]

  switch (rule.kind) {
    case 'term': {
      if (rule.word !== undefined) {
        // a headed group: `mine term, term host` matches group[name(host), ...] and the children rules run
        // over its remaining nodes; a bare word (`true`) also matches a name or a group wrapping one
        if (node?.kind === 'group' && headWord(node) === rule.word) {
          const inner = matchSequence(
            grammar,
            rule.children,
            node.nodes,
            1,
            into,
          )

          if (inner === undefined || inner < node.nodes.length) {
            return undefined
          }

          capture(into, rule.site, {
            kind: 'word',
            value: rule.word,
            span: spanOfNode(node),
            node,
          })

          return at + 1
        }

        if (node && wordOf(node) === rule.word && rule.children.length === 0) {
          capture(into, rule.site, {
            kind: 'word',
            value: rule.word,
            span: spanOfNode(node),
            node,
          })

          return at + 1
        }

        return undefined
      }

      // a bare `mine term`: one word
      const word = node ? wordOf(node) : undefined

      if (word === undefined) {
        return undefined
      }

      capture(into, rule.site, {
        kind: 'word',
        value: word,
        span: spanOfNode(node),
        node,
      })

      return at + 1
    }

    case 'text': {
      if (node?.kind !== 'text') {
        return undefined
      }

      capture(into, rule.site, {
        kind: 'text',
        value: textOf(node),
        span: spanOfNode(node),
        node,
      })

      return at + 1
    }

    case 'path': {
      // a path or glob rides as a word (`@/book/**/*.tree` is one name node), and a multi-word value is a
      // nested chain (`vitest run` is vitest > run): capture the whole phrase
      const phrase = node ? phraseOf(node) : undefined

      if (phrase === undefined) {
        return undefined
      }

      capture(into, rule.site, {
        kind: 'word',
        value: phrase,
        span: spanOfNode(node),
        node,
      })

      return at + 1
    }

    case 'code': {
      if (
        node?.kind !== 'integer' &&
        node?.kind !== 'decimal' &&
        node?.kind !== 'radix'
      ) {
        return undefined
      }

      const value =
        node.kind === 'radix'
          ? Number(node.value)
          : Number(node.value)
      capture(into, rule.site, {
        kind: 'number',
        value,
        decimal: node.kind === 'decimal',
        span: spanOfNode(node),
        node,
      })

      return at + 1
    }

    case 'node':
      // any ONE node, captured nowhere: the skip a mixed file needs
      return node === undefined ? undefined : at + 1

    case 'open': {
      // a group with any head word: the head is the capture, the children rules must consume the rest
      if (node?.kind !== 'group') {
        return undefined
      }

      const head = headWord(node)

      if (head === undefined) {
        return undefined
      }

      const inner = matchSequence(grammar, rule.children, node.nodes, 1, into)

      if (inner === undefined || inner < node.nodes.length) {
        return undefined
      }

      capture(into, rule.site, {
        kind: 'word',
        value: head,
        span: spanOfNode(node),
        node,
      })

      return at + 1
    }

    case 'maybe': {
      const trial: MillMatch = new Map()
      const next = matchSequence(
        grammar,
        rule.children,
        nodes,
        at,
        trial,
      )

      if (next === undefined) {
        return at
      }

      for (const [site, values] of trial) {
        for (const value of values) {
          capture(into, site, value)
        }
      }

      return next
    }

    case 'list': {
      let cursor = at

      for (;;) {
        const trial: MillMatch = new Map()
        const next = matchSequence(
          grammar,
          rule.children,
          nodes,
          cursor,
          trial,
        )

        if (next === undefined || next === cursor) {
          return cursor
        }

        for (const [site, values] of trial) {
          for (const value of values) {
            capture(into, site, value)
          }
        }

        cursor = next
      }
    }

    case 'any': {
      for (const alternative of rule.children) {
        const trial: MillMatch = new Map()
        const next = matchRule(
          grammar,
          alternative,
          nodes,
          at,
          trial,
        )

        if (next !== undefined) {
          for (const [site, values] of trial) {
            for (const value of values) {
              capture(into, site, value)
            }
          }

          return next
        }
      }

      return undefined
    }

    case 'form': {
      const rules = grammar.get(rule.like)

      if (!rules || node === undefined) {
        return undefined
      }

      const inner: MillMatch = new Map()
      // a named rule runs against the node STREAM from here: a rule like fork-test-pair is a sequence of two
      // sibling groups (`hook test`, `hook hold`), so it may consume more than one node. Consuming none is no match.
      const next = matchSequence(grammar, rules, nodes, at, inner)

      if (next === undefined || next === at) {
        return undefined
      }

      capture(into, rule.site, {
        kind: 'match',
        rule: rule.like,
        match: inner,
        span: spanOfNode(node),
        node,
      })

      return next
    }

    default:
      return undefined
  }
}

// run a grammar's start rule over a whole parse tree (the root's groups)
export function runMine(
  grammar: MineGrammar,
  start: string,
  tree: RootNode,
): { ok: true; match: MillMatch } | { ok: false; at?: Node } {
  const rules = grammar.get(start)

  if (!rules) {
    return { ok: false }
  }

  const match: MillMatch = new Map()
  const nodes: Node[] = tree.nodes
  const next = matchSequence(grammar, rules, nodes, 0, match)

  if (next === undefined || next < nodes.length) {
    return { ok: false, at: nodes[next ?? 0] }
  }

  return { ok: true, match }
}

// ---- the mint grammar ----

export type MintCase = { name: string; mint?: string; site?: string }
export type MintBind = { name: string; read: string; nested?: MintMake }
export type MintMake = { form: string; binds: MintBind[] }
export type Mint = {
  name: string
  like?: string
  cases: MintCase[]
  make?: MintMake
}

export type MintGrammar = Map<string, Mint>

export function readMintGrammar(tree: RootNode): MintGrammar {
  const grammar: MintGrammar = new Map()

  for (const group of tree.nodes) {
    if (headWord(group) !== 'mint') {
      continue
    }

    const name = wordOf(group.nodes[1])

    if (!name) {
      continue
    }

    const likeGroup = group.nodes.find(
      (n, i): n is GroupNode =>
        i >= 2 && n.kind === 'group' && headWord(n) === 'like',
    )
    const like = likeGroup ? wordOf(likeGroup.nodes[1]) : undefined
    const cases: MintCase[] = []
    let make: MintMake | undefined

    for (const child of group.nodes.slice(2)) {
      if (child.kind !== 'group') {
        continue
      }

      const head = headWord(child)

      if (head === 'case') {
        const caseName = wordOf(child.nodes[1])
        const mintGroup = child.nodes.find(
          (n, i): n is GroupNode =>
            i >= 2 && n.kind === 'group' && headWord(n) === 'mint',
        )
        const siteGroup = child.nodes.find(
          (n): n is GroupNode =>
            n.kind === 'group' && headWord(n) === 'site',
        )

        if (caseName) {
          cases.push({
            name: caseName,
            mint: mintGroup ? wordOf(mintGroup.nodes[1]) : undefined,
            site: siteGroup ? wordOf(siteGroup.nodes[1]) : undefined,
          })
        }
      } else if (head === 'hook' && wordOf(child.nodes[1]) === 'make') {
        // the hook's own `make` word rides as a bare marker group; the construction is the make group WITH content
        const makeGroup = child.nodes.find(
          (n): n is GroupNode =>
            n.kind === 'group' &&
            headWord(n) === 'make' &&
            n.nodes.length > 1,
        )

        if (makeGroup) {
          make = readMake(makeGroup)
        }
      }
    }

    grammar.set(name, { name, like, cases, make })
  }

  return grammar
}

function readMake(group: GroupNode): MintMake {
  // `make data-entry` with indented binds parses as make > data-entry{binds...} (children nest under the last
  // word), and a comma form puts them beside it: look in both places
  const formGroup =
    group.nodes[1]?.kind === 'group' ? group.nodes[1] : undefined
  const form = wordOf(group.nodes[1]) ?? ''
  const candidates: Node[] = [
    ...(formGroup ? formGroup.nodes.slice(1) : []),
    ...group.nodes.slice(2),
  ]
  const binds: MintBind[] = []

  for (const child of candidates) {
    if (child.kind !== 'group' || headWord(child) !== 'bind') {
      continue
    }

    const keyGroup =
      child.nodes[1]?.kind === 'group' ? child.nodes[1] : undefined
    const name = wordOf(child.nodes[1]) ?? ''
    const valueNodes: Node[] = [
      ...(keyGroup ? keyGroup.nodes.slice(1) : []),
      ...child.nodes.slice(2),
    ]
    // `bind f, read x` reads a case; `bind f / make ...` nests a construction
    const readGroup = valueNodes.find(
      (n): n is GroupNode =>
        n.kind === 'group' && headWord(n) === 'read',
    )
    const makeGroup = valueNodes.find(
      (n): n is GroupNode =>
        n.kind === 'group' && headWord(n) === 'make' && n.nodes.length > 1,
    )

    if (readGroup) {
      binds.push({ name, read: wordOf(readGroup.nodes[1]) ?? '' })
    } else if (makeGroup) {
      binds.push({
        name,
        read: '',
        nested: readMake(makeGroup),
      })
    }
  }

  return { form, binds }
}

// ---- minting ----

// A minted value keeps the CST node it was built from (and that node's extent), so the bridge that turns these
// into compiler AST nodes can carry an exact span onto every one of them. Minting used to drop both, which made
// the executor's output unusable for diagnostics no matter how correct its shapes were.
export type Minted =
  | { kind: 'word'; value: string; span?: Span; node?: Node }
  | { kind: 'text'; value: string; span?: Span; node?: Node }
  | {
      kind: 'number'
      value: number
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

export function runMint(
  mints: MintGrammar,
  name: string,
  match: MillMatch,
  // the CST node this match was read from: it becomes the built form's own node, so the bridge can span it
  node?: Node,
): Minted[] {
  const mint = mints.get(name)

  if (!mint) {
    return []
  }

  // each case pulls its site's captures, minting sub-matches through the named sub-mint
  const byCase = new Map<string, Minted[]>()

  for (const c of mint.cases) {
    const site = c.site ?? c.name
    const captures = match.get(site) ?? []
    const values: Minted[] = []

    for (const cap of captures) {
      if (cap.kind === 'match') {
        const sub = c.mint ?? cap.rule
        values.push(...runMint(mints, sub, cap.match, cap.node))
      } else {
        values.push(cap)
      }
    }

    if (values.length > 0) {
      byCase.set(c.name, values)
    }
  }

  if (mint.make) {
    return [buildMake(mint.make, byCase, node)]
  }

  // Pass-through: the matched cases' values in case order (an alternation yields its one branch).
  //
  // The branch's value takes THIS rule's extent, not its own. A pass-through says "this construct is its
  // branch", and the construct is the wider text: `mine fork` passes through to `fork-test`, which matched at
  // the inner `test` group, while the statement it becomes covers `fork test` and every arm under it. Without
  // this the built node's span points at one word in the middle of the construct it describes.
  const out: Minted[] = []

  for (const c of mint.cases) {
    for (const value of byCase.get(c.name) ?? []) {
      out.push(
        node && value.kind === 'form'
          ? { ...value, span: spanOfWhole(node), node }
          : value,
      )
    }
  }

  return out
}

function buildMake(
  make: MintMake,
  byCase: Map<string, Minted[]>,
  node?: Node,
): Minted {
  const fields: Record<string, Minted[]> = {}

  for (const bind of make.binds) {
    if (bind.nested) {
      fields[bind.name] = [buildMake(bind.nested, byCase, node)]
    } else {
      fields[bind.name] = byCase.get(bind.read) ?? []
    }
  }

  return {
    kind: 'form',
    form: make.form,
    fields,
    span: node ? spanOfWhole(node) : undefined,
    node,
  }
}
