// Read a `.tree` source a top-level group at a time, without holding the whole file.
//
// THE UNIT IS A COMPLETED TOP-LEVEL GROUP, decided in note/term/feed/tree-stream-unit.md and measured there: the
// consumers that exist want a PREFIX of the groups, and the import block is the first 6.4% of a Term file (716
// files, 94,178 lines). `importPathsOf`, `isDataTree`, `isDraftTree` and `scanDefs` all stop before the first
// definition. A cold compile parses every transitive module whole today just to read its imports.
//
// THERE IS ONE PARSER, and this is not a second one. It finds a group's BOUNDARY by line (a top-level group ends
// where the next column-0 line begins) and then hands that slice to `parse`, the same function the whole-file path
// uses. The tree a consumer receives is the same GroupNode, from the same tokenizer and the same event layer.
//
// The boundary question is the whole difficulty, because a column-0 line inside a multi-line `text <...>` literal
// is CONTENT, not a new group. Rather than track literal depth by hand — which is exactly the mistake that made
// the old import scan drop a file's `load` statements when a comment held one bare `<` — this asks the parser: a
// slice that does not parse yet is not a complete group, so the reader keeps reading. That is slower than counting
// angle brackets and it cannot disagree with the grammar, which is the trade this codebase makes every time.

import { parse } from '@term/make/code/parser/tree'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { GroupNode } from '@term/make/code/parser/tree'

export type StreamResult =
  // a completed top-level group
  | { kind: 'group'; group: GroupNode; lines: number }
  // the input ended
  | { kind: 'end' }
  // the input ended in the middle of a construct, or a group does not parse
  | { kind: 'kink'; diagnostics: Diagnostic[]; lines: number }

// Does a line begin a new top-level group? A group's head sits at column 0, so a line starting with a space or a
// tab continues the one above it, and a blank line belongs to whatever came before.
//
// A COMMENT NEVER OPENS ONE, whatever column it sits in. A `#` line before a group is that group's leading
// trivia and the parser attaches it there; a `#` line at column 0 in the middle of an indented block is a note
// about the code around it. deck/seed/code/native/swift/view.tree is written that way throughout — column-0
// comments quoting Swift signatures, between indented `task` lines — and treating them as boundaries cut a group
// in half and reported the file as truncated.
function opensGroup(line: string): boolean {
  if (line.length === 0 || line.startsWith(' ') || line.startsWith('\t')) {
    return false
  }

  return !line.startsWith('#')
}

// The groups of a source, in order, each handed over as soon as it is complete.
//
// A consumer may stop after any one of them and pays only for what it read: the reader holds the current group's
// lines and nothing else, so resident memory is bounded by the DEEPEST group rather than by the file. Returning
// `false` from `take` stops the walk, and costs the groups already read.
//
// PUSH, NOT A GENERATOR, and that is a portability decision rather than a style one (self-hosting-0002). Term has
// no `function*` and no `yield`, so a pull-shaped reader is a thing the compiler cannot be written in. Every
// generator in the compiler was examined and each one is this same shape: produce a sequence, let the consumer
// leave early. A closure that returns `false` to stop expresses exactly that, is one construct Term already has,
// and the Rust backend already boxes closures. The alternative -- adding coroutines to the language -- buys
// nothing else and costs a backend feature on all four targets.
//
// A source is either a whole string (convenient, and what a test or an editor already holds) or an ITERABLE OF
// LINES, which is what makes the reader independent of the file's size: nothing but the current group is resident,
// so a file larger than the heap streams through. `readLines` in this file turns a text into the second.
export type TreeSource =
  | { file: string; text: string }
  | { file: string; lines: Iterable<string> }

// `false` stops the walk. Returning nothing continues it, so the common consumer writes no return at all.
export type TakeResult = (result: StreamResult) => boolean | void

// the lines of a source, without materialising the whole file when it was given as lines
//
// The `for..of` over an `Iterable` is the one JavaScript-only step in this file and it is deliberate: an iterable
// is what a node caller already holds (a `readline` interface, a generator in a test), so adapting it here keeps
// the adaptation at the edge instead of in every caller. The Term port takes a line walker directly.
function walkLines(source: TreeSource, take: (line: string) => boolean): void {
  if ('lines' in source) {
    for (const line of source.lines) {
      if (!take(line)) {
        return
      }
    }

    return
  }

  // a whole string still has to be split, but the split is the caller's memory, not the reader's
  for (const line of source.text.split('\n')) {
    if (!take(line)) {
      return
    }
  }
}

export function walkGroups(source: TreeSource, take: TakeResult): void {
  let held: string[] = []
  let stopped = false

  // one place that reports a result and records whether the consumer wants more
  const give = (result: StreamResult): boolean => {
    if (take(result) === false) {
      stopped = true

      return false
    }

    return true
  }

  // the group `held` currently holds, parsed, or undefined when it is not complete yet
  const complete = (): GroupNode | undefined => {
    if (held.every(line => line.trim() === '' || line.trimStart().startsWith('#'))) {
      return undefined
    }

    const parsed = parse({ file: source.file, text: held.join('\n') })

    return parsed.ok && parsed.tree.nodes.length === 1
      ? parsed.tree.nodes[0]
      : undefined
  }

  walkLines(source, line => {
    // a new group starts here only if what is held is already a complete one. Held lines that do not parse are an
    // unclosed construct (a `text <...>` spanning lines), and this column-0 line is its content.
    if (held.length > 0 && opensGroup(line)) {
      const group = complete()

      if (group) {
        if (!give({ kind: 'group', group, lines: held.length })) {
          return false
        }

        held = []
      }
    }

    held.push(line)

    return true
  })

  if (stopped) {
    return
  }

  if (held.length === 0) {
    give({ kind: 'end' })

    return
  }

  const group = complete()

  if (group) {
    if (give({ kind: 'group', group, lines: held.length })) {
      give({ kind: 'end' })
    }

    return
  }

  // Trailing lines that are only comments or blanks are not a group and are not a failure: a file may end with a
  // comment. Anything else that will not parse ended mid-construct, and saying so is the point — a reader that
  // reported `end` here would let a consumer mistake a truncated file for a whole one.
  const trailing = held.every(
    line => line.trim() === '' || line.trimStart().startsWith('#'),
  )

  if (trailing) {
    give({ kind: 'end' })

    return
  }

  const parsed = parse({ file: source.file, text: held.join('\n') })

  give({
    kind: 'kink',
    diagnostics: parsed.ok ? [] : parsed.diagnostics,
    lines: held.length,
  })
}
