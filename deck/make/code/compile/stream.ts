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
 * The block boundary rule is Term since 2026-10-04, compile/block-split.tree,
 * a splitter fed one line at a time. These are its two drivers: an iterable
 * of lines, and a file read through node's `readline`.
 *
 * Invariant (tested): `splitStreaming([...source.split('\n')])` is
 * byte-for-byte the same block list as `splitTopLevel(source)`.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { feedLine, finishBlocks, makeBlockSplitter } from '@term/make/code/compile/block-split'
import type { TopBlock } from '@term/make/code/compile/incremental-parse'

/**
 * Split a line stream into top-level blocks, emitting each via `onBlock`
 * as soon as it completes. Holds only the current block plus the
 * trailing trivia that may ride forward. Equivalent to `splitTopLevel`
 * on the joined source.
 */
export function splitStreaming(
  lines: Iterable<string>,
  onBlock: (block: TopBlock) => void,
): void {
  const splitter = makeBlockSplitter()

  for (const line of lines) {
    for (const block of feedLine(splitter, line)) {
      onBlock(block)
    }
  }

  // the final block (everything still buffered)
  onBlock(finishBlocks(splitter))
}

/** Collect the streamed blocks into an array (equivalent to splitTopLevel). */
export function splitStreamingToArray(
  lines: Iterable<string>,
): TopBlock[] {
  const out: TopBlock[] = []
  splitStreaming(lines, b => out.push(b))

  return out
}

/**
 * Stream a `.tree` file from disk block-by-block, in constant memory.
 * Hands each top-level block to `take` the instant it completes, holding
 * only the current block plus a tiny trivia backlog - never the whole
 * file. Returning `false` from `take` stops the read.
 *
 * PUSH, NOT AN ASYNC GENERATOR (self-hosting-0002). Term has no
 * `yield`, so the pull shape is one the compiler cannot be written in.
 * `readline`'s async iterator stays, because reading a file line by line
 * is a node capability at the edge rather than a shape in the language.
 */
export async function walkFileBlocks(
  path: string,
  take: (block: TopBlock) => boolean | void,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  const splitter = makeBlockSplitter()

  for await (const line of rl) {
    for (const block of feedLine(splitter, line)) {
      if (take(block) === false) {
        rl.close()

        return
      }
    }
  }

  // the final block (everything still buffered)
  take(finishBlocks(splitter))
}
