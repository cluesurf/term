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
