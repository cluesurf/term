// An import named like one of Term's own value words is never reached by that name, and said so nowhere.
//
// `load @term/base/file` / `find read` imports the file module's `read`, and `read(path)` then reads the VARIABLE
// `path`: the grammar takes `read` as its own word before any name is bound, so the build calls nothing in the file
// module, on all four backends, with no message (guides: applications/targets, 2026-10-03). The same holds for every
// word `mine seed` matches ahead of a bare call (mill/code/code/seed/mine.tree): a `find move` from the file module
// meets the `move` construct. A `name` alias is the way through, `find read, name read-file`, so the warning is on a
// `find` of one of these words that carries none.
//
// Read off the concrete tree, because the alias and the word are both gone by the time the program is built.

import type { Span } from '@term/make/code/parser/diagnostic'
import type { Node, ParseResult } from '@term/make/code/parser/tree'
import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import { groupsOf } from '@term/make/code/parser/narrow'
import { headWord, spanOfNode, wordOf } from '@term/make/code/compile/mill-run'

// the heads `mine seed` reads as a construct before it tries a bare call
const VALUE_WORDS = new Set([
  'call',
  'code',
  'fork',
  'loan',
  'make',
  'meet',
  'move',
  'read',
  'task',
  'term',
  'text',
  'tick',
  'wait',
])

// As the Term port answers them (check/keyword-import.tree): the words as a list, each `find` a `KeywordFind`
export function valueWords(): string[] {
  return [...VALUE_WORDS]
}

export type KeywordFind = { word: string; span: Span }

// does a parsed module define a top-level `task <word>`
export function definesTask(parsed: ParseResult, word: string): boolean {
  return parsed.ok && groupsOf(parsed.tree.nodes).some(group => headWord(group) === 'task' && wordOf(group.nodes[1]) === word)
}

// every `find <word>` under a top-level `load` that imports one of the words with no `name`, where the file writes
// `<word>(` somewhere. `call read` over its arguments does reach the import, and the cask tests call it so, so only the
// call shape the grammar takes as its own word is the trap. The caller keeps those whose word names a task (a form
// named `text` is reached through `like text`, so it is not one of these): the original asked that last, so the caller
// asks it of exactly the words it did
export function keywordCandidates(tree: RootNode): KeywordFind[] {
  const found: KeywordFind[] = []
  const called = calledWords(tree)

  for (const load of groupsOf(tree.nodes)) {
    if (headWord(load) !== 'load') {
      continue
    }

    for (const child of load.nodes.slice(1)) {
      if (child.kind !== 'group' || headWord(child) !== 'find') {
        continue
      }

      const word = wordOf(child.nodes[1])
      const aliased = child.nodes.slice(2).some(part => part.kind === 'group' && headWord(part as GroupNode) === 'name')

      const span = spanOfNode(child)

      if (word !== undefined && VALUE_WORDS.has(word) && !aliased && span && called.has(word)) {
        found.push({ word, span })
      }
    }
  }

  return found
}

// the value words a file writes with a parenthesis straight after them, `read(`, read off the token stream as
// compile/mint-bridge.ts reads `f()`
function calledWords(tree: RootNode): Set<string> {
  const words = new Set<string>()

  const visit = (node: Node | RootNode): void => {
    if (node.kind === 'name') {
      const last = node.parts.at(-1)
      const word = wordOf(node)

      if (word !== undefined && VALUE_WORDS.has(word) && last?.kind === 'chunk' && last.follows !== undefined) {
        words.add(word)
      }

      for (const part of node.parts) {
        if (part.kind === 'interpolation' && part.group) {
          visit(part.group)
        }
      }
    } else if (node.kind === 'text') {
      for (const part of node.parts) {
        if (part.kind === 'interpolation' && part.group) {
          visit(part.group)
        }
      }
    } else if (node.kind === 'group' || node.kind === 'root') {
      node.nodes.forEach(visit)
    }
  }

  visit(tree)

  return words
}
