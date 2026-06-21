// Definition-granular incremental parsing. A Seed file is a sequence of top-level definitions, each a column-0 head
// (`task` / `form` / `load` ...) plus its indented body, with leading comments riding with the definition below them.
// Splitting the source at these boundaries lets the incremental layer re-parse only the definitions whose text
// changed and reuse the rest, instead of re-lexing the whole file on every keystroke. The blocks partition the source
// exactly: `blocks.map(b => b.text).join('\n') === source`.

import { hashText } from '@cluesurf/make/code/compile/cache'
import { parse } from '@cluesurf/make/code/parser/tree'
import type {
  RootNode,
  GroupNode,
  Node,
} from '@cluesurf/make/code/parser/tree'
import type { Span } from '@cluesurf/make/code/parser/diagnostic'

export type TopBlock = {
  // the definition's full source text (its leading comments + head + body)
  text: string
  // the 0-based line in the original file where this block starts (for shifting parsed spans back to absolute)
  startLine: number
  // content hash, the cache key: an unchanged block reuses its prior parse
  hash: string
}

// is this a top-level definition head: a column-0 line that is neither blank nor a comment
function isHead(line: string): boolean {
  return line.length > 0 && line[0] !== ' ' && line[0] !== '\t' && line[0] !== '#'
}

// is this line trivia that rides forward onto the next definition (a blank line or a comment)
function isLeadingTrivia(line: string): boolean {
  return line.trim() === '' || line.trimStart().startsWith('#')
}

export function splitTopLevel(source: string): TopBlock[] {
  const lines = source.split('\n')
  const blocks: TopBlock[] = []
  let start = 0
  let seenHead = false

  const push = (from: number, to: number): void => {
    const text = lines.slice(from, to).join('\n')
    blocks.push({ text, startLine: from, hash: hashText(text) })
  }

  for (let i = 0; i < lines.length; i++) {
    if (isHead(lines[i]!) && seenHead) {
      // a new definition begins; the comment / blank run immediately above it rides forward into the new block
      let boundary = i
      while (
        boundary > start &&
        isLeadingTrivia(lines[boundary - 1]!)
      ) {
        boundary--
      }

      push(start, boundary)
      start = boundary
    }

    if (isHead(lines[i]!)) {
      seenHead = true
    }
  }

  push(start, lines.length)

  return blocks
}

// shift every span in a parsed node by `delta` lines, so a block parsed in isolation (line 0) sits at its real
// position in the file. Mutates in place (the cache stores the block-relative tree and re-positions by delta).
function shiftSpan(span: Span, delta: number): void {
  span.start.line += delta
  span.end.line += delta
}

function shiftNode(node: Node, delta: number): void {
  switch (node.kind) {
    case 'group':
      for (const comment of node.comments ?? []) {
        shiftSpan(comment.span, delta)
      }
      for (const child of node.nodes) {
        shiftNode(child, delta)
      }
      break
    case 'name':
    case 'text':
      for (const part of node.parts) {
        shiftNode(part, delta)
      }
      break
    case 'chunk':
    case 'integer':
    case 'decimal':
    case 'radix':
      shiftSpan(node.token.span, delta)
      break
    case 'interpolation':
      if (node.group) {
        shiftNode(node.group, delta)
      }
      break
  }
}

// the cache an incremental session carries between edits: a definition's parse keyed by its content hash, with the
// line it is currently positioned at (so a reuse re-positions by the delta rather than re-shifting from zero)
export type ParseCache = Map<
  string,
  { groups: GroupNode[]; shiftedTo: number }
>

// parse a file definition-by-definition, reusing the cached parse of every block whose text is unchanged and parsing
// only the changed / new ones. The merged tree is identical to a whole-file parse; `reused` / `parsed` report the
// incremental win. Unchanged blocks that merely moved are re-positioned by a cheap span shift, never re-lexed.
export function incrementalParse(
  file: string,
  source: string,
  cache: ParseCache,
): { tree: RootNode; reused: number; parsed: number } {
  const blocks = splitTopLevel(source)
  const nodes: GroupNode[] = []
  const used = new Set<string>()
  let reused = 0
  let parsed = 0

  for (const block of blocks) {
    const cached = cache.get(block.hash)

    if (cached && !used.has(block.hash)) {
      const delta = block.startLine - cached.shiftedTo
      if (delta !== 0) {
        for (const group of cached.groups) {
          shiftNode(group, delta)
        }
        cached.shiftedTo = block.startLine
      }

      nodes.push(...cached.groups)
      used.add(block.hash)
      reused++
    } else {
      // a changed / new block, or a duplicate of one already used this pass: parse fresh
      const result = parse({ file, text: block.text })
      const groups = result.ok ? result.tree.nodes : []

      for (const group of groups) {
        shiftNode(group, block.startLine)
      }

      // cache only the first occurrence of a hash (a duplicate definition re-parses each pass, which is correct)
      if (!used.has(block.hash)) {
        cache.set(block.hash, { groups, shiftedTo: block.startLine })
        used.add(block.hash)
      }

      nodes.push(...groups)
      parsed++
    }
  }

  // drop cache entries for definitions no longer in the file, so the cache tracks the live set
  for (const hash of [...cache.keys()]) {
    if (!used.has(hash)) {
      cache.delete(hash)
    }
  }

  return { tree: { kind: 'root', nodes }, reused, parsed }
}
