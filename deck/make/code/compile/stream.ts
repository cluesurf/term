/**
 * Streaming top-level block loader for `.tree`. A `.tree` file is a
 * sequence of independent top-level definitions (`splitTopLevel` in
 * incremental-parse.ts splits a whole string into them); this module
 * produces the SAME blocks while reading the file as a STREAM, holding
 * only the current block in memory. That is what lets an arbitrarily
 * large file open in constant memory and start yielding definitions
 * before the last byte is read - the foundation for unbounded file size
 * and viewport-windowed editor parsing (note/seed/tree-streaming-and-perf.md).
 *
 * The block boundary rule is purely lexical (a column-0, non-comment,
 * non-blank head starts a new block; the blank/comment trivia directly
 * above a head rides forward onto it), so it needs only the current line
 * and a small trailing-trivia buffer - never the whole file.
 *
 * Invariant (tested): `splitStreaming([...source.split('\n')])` is
 * byte-for-byte the same block list as `splitTopLevel(source)`.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { hashText } from '@cluesurf/make/code/compile/cache'
import type { TopBlock } from '@cluesurf/make/code/compile/incremental-parse'

function isHead(line: string): boolean {
  return line.length > 0 && line[0] !== ' ' && line[0] !== '\t' && line[0] !== '#'
}

function isLeadingTrivia(line: string): boolean {
  return line.trim() === '' || line.trimStart().startsWith('#')
}

/**
 * Split a line stream into top-level blocks, emitting each via `onBlock`
 * as soon as it completes. Holds only the current block plus the
 * trailing trivia that may ride forward. Equivalent to `splitTopLevel`
 * on the joined source.
 */
export function splitStreaming(lines: Iterable<string>, onBlock: (block: TopBlock) => void): void {
  let block: string[] = []
  let blockStartLine = 0
  let lineNo = 0
  let seenHead = false

  const emit = (lineCount: number): void => {
    const text = block.slice(0, lineCount).join('\n')
    onBlock({ text, startLine: blockStartLine, hash: hashText(text) })
  }

  for (const line of lines) {
    if (isHead(line) && seenHead) {
      // a new definition begins. The blank/comment run at the END of the
      // current block rides forward onto this new one. Find how many lines
      // ride forward (mirror splitTopLevel: never empty the current block).
      let trailing = 0
      while (block.length - trailing > 1 && isLeadingTrivia(block[block.length - 1 - trailing]!)) {
        trailing++
      }
      const keep = block.length - trailing
      const trivia = block.slice(keep)
      emit(keep)
      blockStartLine += keep
      block = trivia
    }

    if (isHead(line)) seenHead = true
    block.push(line)
    lineNo++
  }

  // the final block (everything still buffered)
  emit(block.length)
  void lineNo
}

/** Collect the streamed blocks into an array (equivalent to splitTopLevel). */
export function splitStreamingToArray(lines: Iterable<string>): TopBlock[] {
  const out: TopBlock[] = []
  splitStreaming(lines, b => out.push(b))
  return out
}

/**
 * Stream a `.tree` file from disk block-by-block, in constant memory.
 * Uses readline's async iterator (pull-based), so we hold only the
 * current block plus a tiny trivia backlog - never the whole file - and
 * yield each top-level block the instant it completes.
 */
export async function* streamFileBlocks(path: string): AsyncGenerator<TopBlock> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  let block: string[] = []
  let blockStartLine = 0
  let seenHead = false

  for await (const line of rl) {
    if (isHead(line) && seenHead) {
      let trailing = 0
      while (block.length - trailing > 1 && isLeadingTrivia(block[block.length - 1 - trailing]!)) {
        trailing++
      }
      const keep = block.length - trailing
      const text = block.slice(0, keep).join('\n')
      yield { text, startLine: blockStartLine, hash: hashText(text) }
      blockStartLine += keep
      block = block.slice(keep)
    }

    if (isHead(line)) seenHead = true
    block.push(line)
  }

  // the final block (everything still buffered)
  const text = block.join('\n')
  yield { text, startLine: blockStartLine, hash: hashText(text) }
}
