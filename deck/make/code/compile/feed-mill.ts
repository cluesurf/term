// The feed mill compiler: reads a @term/feed dialect's mine.tree/mint.tree grammar and GENERATES real Term
// (.tree) source text implementing the read/write logic — compiled ahead of time through the ordinary
// parse/mill/check/emit pipeline onto every backend, not interpreted at parse time. Modeled on mill-run.ts's own
// shape (grammar file -> rule objects -> a pass over them), reusing its generic ".tree CST -> word/phrase/text"
// readers, but for a DIFFERENT problem: mill-run.ts matches an already-parsed .tree CST (Term's own syntax) onto
// a typed shape; this reads raw BYTES/CHARACTERS of an arbitrary format (JSON text, a gzip binary blob, hex
// digits) against `@term/feed/code/base.tree`'s `feed-cursor`/`text-cursor` primitives. See
// note/term/project/feed-compiler.md.
//
// Scope, honestly: only the rule kinds `hex`'s grammar actually uses are implemented (list, form, any, range,
// send, value) — proven end to end against `read-hex`/`hex-digit-value`, not assumed. Extending to gzip/json/OTF
// needs more kinds (int, bytes, at, case, maybe, count-directed list) the same way mill-self-hosting grew its
// own rule vocabulary role by role, each one checked before the next.

import type { GroupNode, Node, RootNode } from '@term/make/code/parser/tree'
import { headWord, textOf, wordOf } from './mill-run'

// ---- reading the mine grammar into rule objects ----

export type FeedMineRule =
  | { kind: 'list'; children: FeedMineRule[] }
  | { kind: 'any'; children: FeedMineRule[] }
  | { kind: 'range'; base: string; head: string }
  | { kind: 'form'; name: string; send?: string }
  | { kind: 'value'; expr: GroupNode }
  | { kind: 'send'; name: string }

export type FeedMineGrammar = Map<string, FeedMineRule[]>

function bindTextOf(group: GroupNode, name: string): string | undefined {
  for (const child of group.nodes) {
    if (child.kind === 'group' && headWord(child) === 'bind') {
      const key = wordOf(child.nodes[1])

      if (key === name) {
        const valueNode = child.nodes[1]?.kind === 'group' ? child.nodes[1].nodes[1] : child.nodes[2]

        return valueNode ? textOf(valueNode) : undefined
      }
    }
  }

  return undefined
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
  const children = (): FeedMineRule[] => {
    const out: FeedMineRule[] = []

    for (const child of group.nodes.slice(2)) {
      if (child.kind === 'group') {
        const rule = readFeedMineRule(child)

        if (rule) {
          out.push(rule)
        }
      }
    }

    return out
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
      const formGroup = group.nodes.find(
        (n, i): n is GroupNode => i >= 2 && n.kind === 'group' && headWord(n) === 'form',
      )
      const name = formGroup ? wordOf(formGroup.nodes[1]) : undefined
      const sendGroup = group.nodes.find(
        (n, i): n is GroupNode => i >= 2 && n.kind === 'group' && headWord(n) === 'send',
      )
      const send = sendGroup ? wordOf(sendGroup.nodes[1]) : undefined

      return name ? { kind: 'form', name, send } : undefined
    }
    case 'value': {
      // the value is an arbitrary Term expression: the first (and only meaningful) child group, re-emitted
      // verbatim by the printer in feed-mill-emit.ts, not interpreted here
      const exprGroup = group.nodes.find((n, i): n is GroupNode => i >= 2 && n.kind === 'group')

      return exprGroup ? { kind: 'value', expr: exprGroup } : undefined
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

    for (const child of group.nodes.slice(2)) {
      if (child.kind === 'group') {
        const rule = readFeedMineRule(child)

        if (rule) {
          rules.push(rule)
        }
      }
    }

    grammar.set(name, rules)
  }

  return grammar
}

// ---- printing an embedded Term expression node back to .tree source text ----
//
// mine value / mint's own inline `call` embeddings are already valid Term syntax fragments; this reconstructs
// them as text rather than parsing them semantically, since the ordinary compiler pipeline (parse -> mill ->
// check) does that job once the generated file goes through it. Every group prints in the PAREN form
// (`head(a, b, c)`), which CLAUDE.md's own comma-chain rule confirms is always equivalent to the stacked/comma
// forms, so this doesn't need to replicate whichever the source originally used.
export function printNode(node: Node): string {
  switch (node.kind) {
    case 'name':
      return wordOf(node) ?? ''
    case 'text':
      return `text <${textOf(node)}>`
    case 'integer':
      return `code ${node.value}`
    case 'decimal':
      return `code ${node.value}`
    case 'radix':
      return `code ${node.value}`
    case 'group': {
      const head = node.nodes[0]

      if (!head) {
        return ''
      }

      const headText = printNode(head)
      const rest = node.nodes.slice(1)

      if (rest.length === 0) {
        return headText
      }

      return `${headText}(${rest.map(printNode).join(', ')})`
    }
    default:
      return ''
  }
}

// ---- compiling a mine grammar to .tree source text ----
//
// every named rule becomes `task read-<name>(cursor) -> like number / like text / ...`, reading a `text-cursor`
// (feed's dialects that use this compiler so far are all text-substrate; a byte-cursor target is the same shape
// against `feed-cursor` once a binary dialect needs it, not built until one does). `list`/`any`/`range`/`form`
// generate ordinary `walk test`/`fork test`/`call` Term against `../base.tree`'s cursor primitives; `value`
// re-emits its expression verbatim, with `send`-named captures available as locals of the same name.
export function compileFeedMine(grammar: FeedMineGrammar, cursorImportPath: string): string {
  const lines: string[] = []

  lines.push(`load ${cursorImportPath}`)
  lines.push('  find text-cursor')
  lines.push('  find text-cursor-at-end')
  lines.push('  find text-cursor-peek')
  lines.push('  find text-cursor-peek-code')
  lines.push('  find text-cursor-read')
  lines.push('')
  lines.push('load @term/seed/code/list')
  lines.push('  find push')
  lines.push('')
  lines.push('load @term/seed/code/boolean')
  lines.push('  find and')
  lines.push('  find not')
  lines.push('')

  for (const [name, rules] of grammar) {
    lines.push(...compileRule(name, rules))
    lines.push('')
  }

  return lines.join('\n')
}

function compileRule(name: string, rules: FeedMineRule[]): string[] {
  const taskName = `read-${name}`
  const lines: string[] = [`task ${taskName}`, '  take cursor, like text-cursor']
  const body: string[] = []
  const sends: string[] = []

  // a rule with exactly one top-level `mine list` and nothing else returns that list directly; every other
  // shape runs its children in sequence, collecting `send`-named captures as locals, then returns either the
  // last capture (one send, no `value`), the explicit `mine value` expression, or nothing
  if (rules.length === 1 && rules[0]!.kind === 'list') {
    lines.push('  like list', '    like number')
    body.push(...compileExpr(rules[0]!, 2))
    lines.push('  send back')
    lines.push('    call read-list-0(read cursor)')

    // inline the list logic directly rather than a helper indirection: emit it as the body
    lines.length = 2
    lines.push('  like list')
    lines.push('    like number')
    lines.push('  save result')
    lines.push('    make list')
    const inner = rules[0]! as { kind: 'list'; children: FeedMineRule[] }
    lines.push('  walk test')
    lines.push('    hook test')
    lines.push('      call not, call text-cursor-at-end(read cursor)')
    lines.push('    hook hold')

    for (const line of compileSequence(inner.children, 3, sends)) {
      lines.push(line)
    }

    const last = sends[sends.length - 1]

    lines.push(`      call push(read result, read ${last})`)
    lines.push('  send back, read result')

    return lines
  }

  let valueExpr: GroupNode | undefined

  for (const rule of rules) {
    if (rule.kind === 'value') {
      valueExpr = rule.expr
      continue
    }

    body.push(...compileExpr(rule, 1, sends))
  }

  lines.push('  like number')
  lines.push(...body)

  if (valueExpr) {
    lines.push('  send back')
    lines.push(`    ${printNode(valueExpr)}`)
  } else if (sends.length > 0) {
    lines.push(`  send back, read ${sends[sends.length - 1]}`)
  }

  return lines
}

function compileSequence(rules: FeedMineRule[], indent: number, sends: string[]): string[] {
  const lines: string[] = []

  for (const rule of rules) {
    lines.push(...compileExpr(rule, indent, sends))
  }

  return lines
}

function pad(indent: number): string {
  return '  '.repeat(indent)
}

let anyCounter = 0

function compileExpr(rule: FeedMineRule, indent: number, sends: string[] = []): string[] {
  const p = pad(indent)

  switch (rule.kind) {
    case 'form': {
      const localName = rule.send ?? `match-${sends.length}`

      if (rule.send) {
        sends.push(rule.send)
      }

      return [`${p}save ${localName}`, `${p}  call read-${rule.name}(read cursor)`]
    }
    case 'any': {
      const id = anyCounter++
      const localName = `any-${id}`
      const out: string[] = [`${p}save ${localName}`]
      const branches = rule.children

      for (let i = 0; i < branches.length; i++) {
        const branch = branches[i]!

        if (branch.kind !== 'range') {
          continue
        }

        const test = i === 0 ? 'fork test' : undefined

        out.push(`${p}  ${test ?? ''}`.trimEnd())
        out.push(`${p}    hook test`)
        out.push(...rangeTest(branch, indent + 3))
        out.push(`${p}    hook hold`)
        out.push(`${p}      save ${localName}, call text-cursor-read(read cursor)`)
      }

      sends.push(localName)

      return out
    }
    case 'send':
      sends.push(rule.name)

      return []
    case 'range':
    case 'list':
    case 'value':
      return []
  }
}

function rangeTest(rule: { base: string; head: string }, indent: number): string[] {
  const p = pad(indent)
  const baseCode = rule.base.codePointAt(0) ?? 0
  const headCode = rule.head.codePointAt(0) ?? 0

  return [
    `${p}call and`,
    `${p}  call is-minimum(call text-cursor-peek-code(read cursor), code ${baseCode})`,
    `${p}  call is-maximum(call text-cursor-peek-code(read cursor), code ${headCode})`,
  ]
}
