// Read a `.tree` source a top-level group at a time, without holding the whole file.
//
// THE UNIT IS A COMPLETED TOP-LEVEL GROUP, decided in note/term/feed/tree-stream-unit.md and measured there: the
// consumers that exist want a PREFIX of the groups, and the import block is the first 6.4% of a Term file (716
// files, 94,178 lines). `importPathsOf`, `isDataTree`, `isDraftTree` and `scanDefs` all stop before the first
// definition. A cold compile parses every transitive module whole today just to read its imports.
//
// THERE IS ONE PARSER, and this is not a second one. It finds a group's BOUNDARY by line (a top-level group ends
// where the next column-0 line begins) and then hands that slice to `parse`, the same function the whole-file path
// uses. The boundary question is answered by asking the parser: a slice that does not parse yet is not a complete
// group, so the reader keeps reading.
//
// The reader is parser/streaming.tree (self-hosting, 2026-10-06). This face turns a source into the task that hands
// it a line at a time, and keeps the shapes callers hold.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { walkGroups as walk } from '@term/make/code/parser/streaming'

export type StreamResult =
  // a completed top-level group
  | { kind: 'group'; group: GroupNode; lines: number }
  // the input ended
  | { kind: 'end' }
  // the input ended in the middle of a construct, or a group does not parse
  | { kind: 'kink'; diagnostics: Diagnostic[]; lines: number }

// PUSH, NOT A GENERATOR, and that is a portability decision rather than a style one (self-hosting-0002): Term has
// no `function*`, and a closure that returns `false` to stop expresses exactly "produce a sequence, let the consumer
// leave early".
//
// A source is either a whole string or an ITERABLE OF LINES, which is what makes the reader independent of the file's
// size: nothing but the current group is resident, so a file larger than the heap streams through.
export type TreeSource =
  | { file: string; text: string }
  | { file: string; lines: Iterable<string> }

// `false` stops the walk. Returning nothing continues it, so the common consumer writes no return at all.
export type TakeResult = (result: StreamResult) => boolean | void

export function walkGroups(source: TreeSource, take: TakeResult): void {
  const lines = 'lines' in source ? source.lines[Symbol.iterator]() : source.text.split('\n')[Symbol.iterator]()
  let done = false
  const nextLine = (): { form: 'some'; value: string } | { form: 'none' } => {
    const one = lines.next()

    if (one.done) {
      done = true

      return { form: 'none' }
    }

    return { form: 'some', value: one.value }
  }

  walk(source.file, nextLine, result => take(result as StreamResult) !== false)

  // an iterable the walk stopped early is closed, as a `for..of` that returns closes it
  if (!done) {
    lines.return?.()
  }
}
