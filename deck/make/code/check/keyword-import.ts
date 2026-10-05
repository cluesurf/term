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
import type { GroupNode, Node, ParseResult, RootNode } from '@term/make/code/parser/tree'
import { headWord, spanOfNode, wordOf } from '@term/make/code/compile/mill-run'

// the heads `mine seed` reads as a construct before it tries a bare call
export const VALUE_WORDS = new Set([
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

export type KeywordImport = { word: string; span: Span }

// does a parsed module define a top-level `task <word>`
export function definesTask(parsed: ParseResult, word: string): boolean {
  return parsed.ok && parsed.tree.nodes.some(group => headWord(group) === 'task' && wordOf(group.nodes[1]) === word)
}

// every `find <word>` under a top-level `load` that imports one of the words with no `name`, where `isTask` says the
// word names a task (a form named `text` is reached through `like text`, so it is not one of these), and the file
// writes `<word>(` somewhere. `call read` over its arguments does reach the import, and the cask tests call it so,
// so only the call shape the grammar takes as its own word is the trap
export function keywordImports(tree: RootNode, isTask: (word: string) => boolean): KeywordImport[] {
  const found: KeywordImport[] = []
  const called = calledWords(tree)

  for (const load of tree.nodes) {
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

      if (word !== undefined && VALUE_WORDS.has(word) && !aliased && span && called.has(word) && isTask(word)) {
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

  const visit = (node: Node): void => {
    if (node.kind === 'name') {
      const last = node.parts.at(-1)
      const word = wordOf(node)

      if (word !== undefined && VALUE_WORDS.has(word) && last?.kind === 'chunk' && (last.token as { next?: { kind: string } }).next?.kind === 'open-paren') {
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
