// Rewrite every `.tree` line whose meaning depends on the comma rule into a spelling that means the same under both.
//
// THE RULE CHANGE. Until 2026-10-02 a comma after a literal or after a call closed by its own parenthesis popped the
// level ABOVE that part, so in `want hold, is-equal get(found, 1), 14` the `14` landed beside `is-equal`. Under the
// new rule (`CommaAfterLeaf` in deck/make/code/parser/event.ts, `stays`) a part that opened no level leaves the comma at
// its own level, so `14` is the second argument of `is-equal`. note/project/term/lean/lean-surface-second-pass.md, section 3.
//
// WHAT THIS DOES. For each file, every line outside a multi-line text literal (the tokens say where one opens and
// closes) is parsed on its own under both rules. A line whose
// two trees differ is re-spelled from its OLD tree in a form both rules read the same way: every part that has parts
// of its own is written with its parentheses (`name(<killed>)`, `get(found, 1)`), and only a last part with a
// single part of its own keeps the space (`like native-boolean`). Where that does not round-trip, the line's parts
// are stacked on their own indented lines instead, which indentation decides alone.
//
// THE PROOF, per file, before anything is written: the whole file's tree under the OLD rule before the rewrite
// equals its tree under the NEW rule after it, node for node, and the `load` / `bear` paths it names are the same.
// A file that fails the proof is listed and left as it is. Reports by default; writes only with --commit, reading
// each file again immediately before writing it and refusing one that changed since it was read.
//
//   pnpm term:comma-migrate --list <file of paths>            report
//   pnpm term:comma-migrate --list <file of paths> --commit   write
//   pnpm term:comma-migrate <path> [<path> ...]
//   --respell   re-spell only the lines this migration wrote (absent from git HEAD) with the lighter spelling
//   --dump <d>  write every rewritten text to <d>, proven or not, to read a refusal

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import { tokenize } from '@term/make/code/parser/token'
import { importPathsOf } from '@term/make/code/compile/load'

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const listAt = argv.indexOf('--list')
const dumpAt = argv.indexOf('--dump')
const dumpTo = dumpAt >= 0 ? argv[dumpAt + 1] : undefined
const files =
  listAt >= 0
    ? readFileSync(argv[listAt + 1]!, 'utf8').split('\n').filter(Boolean)
    : argv.filter((arg, at) => !arg.startsWith('--') && argv[at - 1] !== '--dump')

// `test/parser/file/` holds fixtures written as source, `---`, and the tree the parser must build. Their expected
// trees DEFINE the comma rule, so they are rewritten to the new rule by hand, never re-spelled here.
const FIXTURES = /\/test\/parser\/file\//

type Rule = 'old' | 'new'

// the comma rule each reading parses under: the grammar's, or the superseded one
function afterLeafOf(rule: Rule): 'stays' | 'pops' {
  return rule === 'new' ? 'stays' : 'pops'
}

function parseUnder(rule: Rule, file: string, text: string): RootNode | undefined {
  const parsed = parse({ file, text }, afterLeafOf(rule))

  return parsed.ok ? parsed.tree : undefined
}

// the tree as a string: every node's kind and text, in order, and nothing positional
function show(node: Node): string {
  switch (node.kind) {
    case 'root':
      return node.nodes.map(show).join('\n')
    case 'group':
      return `(${node.optional ? '?' : ''}${node.nodes.map(show).join(' ')})`
    case 'name':
    case 'text':
      return `${node.kind === 'text' ? 't' : 'n'}[${node.parts
        .map(p => (p.kind === 'chunk' ? JSON.stringify(p.text) : `{${p.depth}:${p.group ? show(p.group) : ''}}`))
        .join('')}]`
    case 'integer':
    case 'decimal':
    case 'radix':
      return `${node.kind}:${node.text}`
    default:
      return node.kind
  }
}

function imports(rule: Rule, file: string, text: string): string {
  try {
    return importPathsOf({ file, text }, source => parse(source, afterLeafOf(rule))).join('|')
  } catch {
    return '(unreadable)'
  }
}

// ---- spelling a line both rules read alike ----

function head(group: GroupNode): string {
  return `${group.nodes[0] ? renderHead(group.nodes[0]) : ''}${group.optional ? '?' : ''}`
}

function hasParts(node: Node): node is GroupNode {
  return node.kind === 'group' && node.nodes.length > 1
}

// a part with exactly one part of its own, and that part a word or a literal: `read list`, `code 0`
function singleLeaf(node: Node): node is GroupNode {
  return hasParts(node) && node.nodes.length === 2 && !hasParts(node.nodes[1]!)
}

// a part inside parentheses: anything with parts of its own is parenthesized too, since a comma after a spaced
// multi-word part pops into it under either rule. The LAST argument may keep its space when it holds a single
// word or literal, because the closing parenthesis ends it under both rules: `size(read list)`, `f(a, code 0)`
function inParens(node: Node): string {
  if (!hasParts(node)) {
    return node.kind === 'group' ? head(node) : renderHead(node)
  }

  const args = node.nodes.slice(1)

  return `${head(node)}(${args
    .map((arg, at) =>
      at === args.length - 1 && singleLeaf(arg)
        ? `${head(arg)} ${partsOf(arg.nodes.slice(1))}`
        : inParens(arg),
    )
    .join(', ')})`
}

// the parts after a head, comma-joined. Only the LAST part may keep the space form, and only when it has a single
// part of its own, because then no comma follows anything inside it
function partsOf(nodes: Node[]): string {
  return nodes
    .map((node, at) => {
      if (!hasParts(node)) {
        return node.kind === 'group' ? head(node) : renderHead(node)
      }

      const last = at === nodes.length - 1

      if (last && node.nodes.length === 2) {
        return `${head(node)} ${partsOf(node.nodes.slice(1))}`
      }

      return inParens(node)
    })
    .join(', ')
}

function inline(group: GroupNode): string {
  const parts = group.nodes.slice(1)

  return parts.length === 0 ? head(group) : `${head(group)} ${partsOf(parts)}`
}

// every part on its own line, under the head, all the way down: indentation alone decides the tree
function stacked(group: GroupNode, indent: string): string[] {
  const out = [`${indent}${head(group)}`]

  for (const part of group.nodes.slice(1)) {
    if (part.kind === 'group') {
      out.push(...stacked(part, `${indent}  `))
    } else {
      out.push(`${indent}  ${renderHead(part)}`)
    }
  }

  return out
}

// the source lines that sit INSIDE a multi-line text literal, after the line that opens it. Their text is content,
// never a line of tree, so it is never touched. Read from the tokens, which know where a literal opens and closes
function textLines(file: string, text: string): Set<number> {
  const inside = new Set<number>()
  const tokens = tokenize({ file, text })

  if (tokens.diagnostics.length > 0) {
    return inside
  }

  let depth = 0
  let opened = 0

  for (const token of tokens.tokens.list) {
    if (token.kind === 'open-angle') {
      if (depth === 0) {
        opened = token.span.start.line
      }

      depth++
    } else if (token.kind === 'close-angle' && depth > 0) {
      depth--

      if (depth === 0) {
        for (let line = opened + 1; line <= token.span.end.line; line++) {
          inside.add(line)
        }
      }
    }
  }

  return inside
}

// the 1-based source line of the smallest subtree where two trees part, read from the first one's tokens
function lineOf(node: Node): number {
  if (node.kind === 'group') {
    for (const part of node.nodes) {
      const line = lineOf(part)

      if (line) {
        return line
      }
    }

    return 0
  }

  if (node.kind === 'name' || node.kind === 'text') {
    const chunk = node.parts.find(p => p.kind === 'chunk')

    return chunk && chunk.kind === 'chunk' ? chunk.span.start.line + 1 : 0
  }

  return 'span' in node ? node.span.start.line + 1 : 0
}

function partingLine(a: Node[], b: Node[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]

    if (!x || !y) {
      return x ? lineOf(x) : 0
    }

    if (show(x) === show(y)) {
      continue
    }

    if (x.kind === 'group' && y.kind === 'group') {
      return partingLine(x.nodes, y.nodes) || lineOf(x)
    }

    return lineOf(x)
  }

  return 0
}

type Outcome =
  | { kind: 'same' }
  | { kind: 'rewritten'; text: string; lines: number[] }
  | { kind: 'unproven'; why: string }

function migrate(file: string, text: string): Outcome {
  const before = parseUnder('old', file, text)

  if (!before) {
    return { kind: 'same' }
  }

  const after = parseUnder('new', file, text)

  if (after && show(before) === show(after)) {
    return { kind: 'same' }
  }

  const lines = text.split('\n')
  const out: string[] = []
  const changed: number[] = []
  const inText = textLines(file, text)

  lines.forEach((line, at) => {
    const body = line.trim()
    const indent = line.slice(0, line.length - line.trimStart().length)

    if (inText.has(at) || body === '' || body.startsWith('#')) {
      out.push(line)
      return
    }

    const old = parseUnder('old', file, body)
    const neu = parseUnder('new', file, body)

    if (!old || !neu || old.nodes.length !== 1 || old.nodes[0]!.kind !== 'group' || show(old) === show(neu)) {
      out.push(line)
      return
    }

    const group = old.nodes[0] as GroupNode
    const want = show(old)
    const reads = (candidate: string) =>
      [parseUnder('old', file, candidate), parseUnder('new', file, candidate)].every(t => t !== undefined && show(t) === want)

    const flat = inline(group)

    if (reads(flat)) {
      out.push(`${indent}${flat}`)
      changed.push(at + 1)
      return
    }

    const tall = stacked(group, '')

    if (reads(tall.join('\n'))) {
      out.push(...tall.map(row => `${indent}${row}`))
      changed.push(at + 1)
      return
    }

    out.push(line)
  })

  const next = out.join('\n')
  const proven = parseUnder('new', file, next)

  // --dump <dir>: the rewritten text of every file, proven or not, for reading a refusal
  if (dumpTo) {
    writeFileSync(`${dumpTo}/${file.split('/').pop()}`, next)
  }

  if (!proven || show(proven) !== show(before)) {
    const line = proven ? partingLine(before.nodes, proven.nodes) : 0

    return {
      kind: 'unproven',
      why: `the rewritten file does not parse to the old tree under the new rule, first at the group on old line ${line}: ${(lines[line - 1] ?? '').trim().slice(0, 120)}`,
    }
  }

  if (imports('new', file, next) !== imports('old', file, text)) {
    return { kind: 'unproven', why: 'the rewritten file names different load paths' }
  }

  return { kind: 'rewritten', text: next, lines: changed }
}

// --respell: after a migration written with an earlier, heavier spelling, re-spell only the lines this migration
// wrote (the lines of the file that git's HEAD copy does not have, `load` and `find` lines aside, which another
// session rewrites) with the current renderer, where that is shorter. Proven the same way: the file's tree is the
// same before and after under BOTH rules.
function respell(file: string, text: string): Outcome {
  let head: string

  try {
    head = execFileSync('git', ['-C', dirname(file), 'show', `HEAD:./${basename(file)}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return { kind: 'same' }
  }

  const known = new Set(head.split('\n').map(line => line.trim()))
  const lines = text.split('\n')
  const changed: number[] = []
  const inText = textLines(file, text)

  const out = lines.map((line, at) => {
    const body = line.trim()

    if (inText.has(at) || body === '' || body.startsWith('#') || known.has(body) || !body.includes('(')) {
      return line
    }

    const old = parseUnder('old', file, body)
    const neu = parseUnder('new', file, body)

    if (!old || !neu || old.nodes.length !== 1 || old.nodes[0]!.kind !== 'group' || show(old) !== show(neu)) {
      return line
    }

    // a `load` or `find` line is another session's to rewrite, read by its head word from the parse
    const lead = old.nodes[0].nodes[0]

    if (lead?.kind === 'name' && ['load', 'find'].includes(renderHead(lead))) {
      return line
    }

    const want = show(old)
    const candidate = inline(old.nodes[0] as GroupNode)
    const reads = [parseUnder('old', file, candidate), parseUnder('new', file, candidate)].every(
      t => t !== undefined && show(t) === want,
    )

    if (!reads || candidate.length >= body.length) {
      return line
    }

    changed.push(at + 1)

    return `${line.slice(0, line.length - line.trimStart().length)}${candidate}`
  })

  if (changed.length === 0) {
    return { kind: 'same' }
  }

  const next = out.join('\n')

  for (const rule of ['old', 'new'] as const) {
    const before = parseUnder(rule, file, text)
    const after = parseUnder(rule, file, next)

    if (!before || !after || show(before) !== show(after) || imports(rule, file, text) !== imports(rule, file, next)) {
      return { kind: 'unproven', why: `the re-spelled file reads differently under the ${rule} rule` }
    }
  }

  return { kind: 'rewritten', text: next, lines: changed }
}

const respelling = argv.includes('--respell')

let same = 0
let rewritten = 0
let fixtures = 0
let lineCount = 0
const unproven: string[] = []

for (const file of files) {
  let text: string

  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }

  const outcome = respelling ? respell(file, text) : migrate(file, text)

  if (outcome.kind === 'same') {
    same++
    continue
  }

  if (FIXTURES.test(file)) {
    fixtures++
    console.log(`FIXTURE   ${file}  (its expected tree defines the rule: update it by hand)`)
    continue
  }

  if (outcome.kind === 'unproven') {
    unproven.push(`${file}  ${outcome.why}`)
    continue
  }

  rewritten++
  lineCount += outcome.lines.length
  const shown = outcome.lines.slice(0, 8).join(' ')
  console.log(`REWRITE   ${file}  ${outcome.lines.length} line(s): ${shown}${outcome.lines.length > 8 ? ' ...' : ''}`)

  if (commit) {
    // read again at write time: another session may have rewritten this file's `load` lines since
    if (readFileSync(file, 'utf8') !== text) {
      unproven.push(`${file}  changed on disk while this ran: run again`)
      rewritten--
      continue
    }

    writeFileSync(file, outcome.text)
  }
}

for (const line of unproven) {
  console.log(`UNPROVEN  ${line}`)
}

console.log(
  `comma-migrate: ${rewritten} files rewritten (${lineCount} lines), ${unproven.length} unproven, ${fixtures} parser fixtures, ${same} unaffected${commit ? ', written' : ', pass --commit to write'}`,
)

if (unproven.length > 0) {
  process.exitCode = 1
}
