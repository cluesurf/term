// The feed mill compiler: reads a @term/feed dialect's mine.tree grammar and GENERATES real Term (.tree) source
// text implementing the reader — compiled ahead of time through the ordinary parse/mill/check/emit pipeline onto
// every backend, not interpreted at parse time. Modeled on mill-run.ts's own shape (grammar file -> rule objects
// -> a pass over them), reusing its generic ".tree CST -> word/phrase/text" readers, but for a DIFFERENT
// problem: mill-run.ts matches an already-parsed .tree CST (Term's own syntax) onto a typed shape; this reads
// raw CHARACTERS of an arbitrary text format (hex digits, JSON, ...) against `@term/feed/code/base.tree`'s
// `text-cursor` primitives. See note/term/project/feed-compiler.md.
//
// Scope, honestly: only the rule kinds `hex`'s grammar actually uses are implemented (list, form, any, range,
// send, value) — proven end to end against `read-hex`/`hex-digit-value`, not assumed. Extending to gzip/json/OTF
// needs more kinds (int, bytes, at, case, maybe, count-directed list) the same way mill-self-hosting grew its
// own rule vocabulary role by role, each one checked before the next.
//
// Every `mine any` compiles to its OWN helper task returning the matched raw text via `send back` inside each
// `hook hold` branch — never a `save` read again after the fork closes. `save` inside a `fork test`/`fork case`
// branch is scoped to that branch, not the enclosing task (feedback_term_fork_case_param_shadow's sibling
// finding, hit and fixed by hand several times this session); `send back` has no such problem, since it exits
// the whole task immediately regardless of which branch it's in. Generating code that would need to read a
// `save` from inside a fork after the fork closes is exactly the bug this avoids by construction.

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
      const keyNode = child.nodes[1]
      const key = keyNode?.kind === 'group' ? wordOf(keyNode.nodes[0]) : wordOf(keyNode)

      if (key !== name) {
        continue
      }

      const valueNode = keyNode?.kind === 'group' ? keyNode.nodes[1] : child.nodes[2]

      return valueNode ? textOf(valueNode) : undefined
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
      // the value is an arbitrary Term expression: the first child group, re-emitted verbatim by `printNode`,
      // never interpreted here
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
// `mine value`'s content is already a valid Term syntax fragment; this reconstructs it as text rather than
// parsing it semantically, since the ordinary compiler pipeline (parse -> mill -> check) does that job once the
// generated file goes through it. Every group prints in the PAREN form (`head(a, b, c)`), which CLAUDE.md's own
// comma-chain rule confirms is always equivalent to the stacked/comma forms, so this doesn't need to replicate
// whichever the source originally used.
export function printNode(node: Node): string {
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

const CURSOR_IMPORTS = [
  'find text-cursor',
  'find text-cursor-at-end',
  'find text-cursor-peek',
  'find text-cursor-peek-code',
  'find text-cursor-read',
]

export function compileFeedMine(grammar: FeedMineGrammar, cursorImportPath: string, extraImports: string[] = []): string {
  const lines: string[] = []

  lines.push(`load ${cursorImportPath}`)

  for (const line of CURSOR_IMPORTS) {
    lines.push(`  ${line}`)
  }

  lines.push('')
  lines.push('load @term/seed/code/list')
  lines.push('  find push')
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
    helpers.length = 0
    helperCounter = 0
    const rule = compileNamedRule(name, rules, () => `${name}-any-${helperCounter++}`, helpers)

    lines.push(...helpers)
    lines.push(...rule)
    lines.push('')
  }

  return lines.join('\n')
}

// a rule whose ENTIRE body is one `mine list` returns the list of its own repeated match directly (`hex`'s own
// shape: a list of hex-byte, nothing else). Every other rule runs its children as an ordinary sequence,
// collecting `send`-named captures as locals, then returns the `mine value` expression (or, with no explicit
// value, the last capture — a rule that only ever captures one thing needs no combination step).
function compileNamedRule(
  name: string,
  rules: FeedMineRule[],
  nextHelperName: () => string,
  helpers: string[],
): string[] {
  const taskName = `read-${name}`

  if (rules.length === 1 && rules[0]!.kind === 'list') {
    const inner = rules[0] as { kind: 'list'; children: FeedMineRule[] }
    const lines: string[] = [
      `task ${taskName}`,
      '  take cursor, like text-cursor',
      '  like list',
      '    like number',
      '  save result',
      '    make list',
      '  walk test',
      '    hook test',
      '      call not, call text-cursor-at-end(read cursor)',
      '    hook hold',
    ]
    const sends: string[] = []

    lines.push(...compileSequence(inner.children, 3, sends, nextHelperName, helpers))

    const captured = sends[sends.length - 1] ?? 'item'

    lines.push(`      call push(read result, read ${captured})`)
    lines.push('  send back, read result')

    return lines
  }

  const sends: string[] = []
  const body: string[] = []
  let valueExpr: GroupNode | undefined

  for (const rule of rules) {
    if (rule.kind === 'value') {
      valueExpr = rule.expr
      continue
    }

    body.push(...compileExpr(rule, 1, sends, nextHelperName, helpers))
  }

  const lines: string[] = [`task ${taskName}`, '  take cursor, like text-cursor', '  like number', ...body]

  if (valueExpr) {
    lines.push('  send back')
    lines.push(`    ${printNode(valueExpr)}`)
  } else if (sends.length > 0) {
    lines.push(`  send back, read ${sends[sends.length - 1]}`)
  }

  return lines
}

function compileSequence(
  rules: FeedMineRule[],
  indent: number,
  sends: string[],
  nextHelperName: () => string,
  helpers: string[],
): string[] {
  const lines: string[] = []

  for (const rule of rules) {
    lines.push(...compileExpr(rule, indent, sends, nextHelperName, helpers))
  }

  return lines
}

function pad(indent: number): string {
  return '  '.repeat(indent)
}

function compileExpr(
  rule: FeedMineRule,
  indent: number,
  sends: string[],
  nextHelperName: () => string,
  helpers: string[],
): string[] {
  const p = pad(indent)

  switch (rule.kind) {
    case 'form': {
      const localName = rule.send ?? `match-${sends.length}`

      sends.push(localName)

      return [`${p}save ${localName}`, `${p}  call read-${rule.name}(read cursor)`]
    }

    case 'any': {
      const helperName = nextHelperName()

      helpers.push(...compileAnyHelper(helperName, rule.children))

      const localName = `char-${sends.length}`

      sends.push(localName)

      return [`${p}save ${localName}`, `${p}  call ${helperName}(read cursor)`]
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

// `mine any` over a run of `mine range` alternatives becomes its own helper task: one `fork test` with one
// `hook test`/`hook hold` pair per range, each `hook hold` returning the matched character directly via `send
// back` (never a `save` a caller would need to read after the fork closes — see this file's own header).
function compileAnyHelper(name: string, branches: FeedMineRule[]): string[] {
  const lines: string[] = [`task ${name}`, '  take cursor, like text-cursor', '  like text']

  branches.forEach((branch, i) => {
    if (branch.kind !== 'range') {
      return
    }

    const baseCode = branch.base.codePointAt(0) ?? 0
    const headCode = branch.head.codePointAt(0) ?? 0
    const keyword = i === 0 ? 'fork test' : undefined

    if (keyword) {
      lines.push(`  ${keyword}`)
    }

    lines.push('    hook test')
    lines.push('      call and')
    lines.push(`        call is-minimum(call text-cursor-peek-code(read cursor), code ${baseCode})`)
    lines.push(`        call is-maximum(call text-cursor-peek-code(read cursor), code ${headCode})`)
    lines.push('    hook hold')
    lines.push('      send back')
    lines.push('        call text-cursor-read(read cursor)')
  })

  lines.push(`  halt <expected a match for ${name}>`)

  return lines
}
