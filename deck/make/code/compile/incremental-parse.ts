// Definition-granular incremental parsing. A Seed file is a sequence of top-level definitions, each a column-0 head
// (`task` / `form` / `load` ...) plus its indented body, with leading comments riding with the definition below them.
// Splitting the source at these boundaries lets the incremental layer re-parse only the definitions whose text
// changed and reuse the rest, instead of re-lexing the whole file on every keystroke. The blocks partition the source
// exactly: `blocks.map(b => b.text).join('\n') === source`.
//
// The reuse, the parse of what changed and the shifting of spans are Term, compile/incremental-parsing.tree
// (self-hosting, 2026-10-07). It shifts in copies, so this face writes what it hands back into the cache its caller
// holds, and no tree an earlier call returned is moved by a later one.

import { feedLine, finishBlocks, makeBlockSplitter } from '@term/make/code/compile/block-split'
import * as parsing from '@term/make/code/compile/incremental-parsing'
import type { RootNode, GroupNode } from '@term/make/code/parser/narrow'

export type TopBlock = {
  // the definition's full source text (its leading comments + head + body)
  text: string
  // the 0-based line in the original file where this block starts (for shifting parsed spans back to absolute)
  startLine: number
  // content hash, the cache key: an unchanged block reuses its prior parse
  hash: string
}

// The blocks of a source: a column-0 line that is neither blank nor a comment starts a definition, and the comment /
// blank run immediately above it rides forward into it, never so far that the block before is left empty. The rule is
// Term, compile/block-split.tree (self-hosting, 2026-10-06), the one the streaming loader feeds a line at a time
// (compile/stream.ts), so the two cannot disagree. This splitter was a second copy of it until then: tmp/pair-stream.ts
// held the two equal, and a head that is ALSO trivia (a line of non-ASCII space, which `trim` empties) once differed
export function splitTopLevel(source: string): TopBlock[] {
  const splitter = makeBlockSplitter()
  const blocks: TopBlock[] = []

  for (const line of source.split('\n')) {
    blocks.push(...feedLine(splitter, line))
  }

  blocks.push(finishBlocks(splitter))

  return blocks
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
  const result = parsing.incrementalParse(file, splitTopLevel(source), cache as Map<string, parsing.BlockEntry>)

  // the cache after this call: the entries the file still holds, shifted, and the blocks parsed this time, in the
  // order the original's writes would have left them
  cache.clear()

  for (const [hash, entry] of result.cache) {
    cache.set(hash, entry as ParseCache extends Map<string, infer V> ? V : never)
  }

  return { tree: result.tree as RootNode, reused: result.reused, parsed: result.parsed }
}
