// A LAW IN WORDS: every `rule` of a program as one plain English sentence, written from the rule's Term form alone, so a
// person approves what was proven and not what the author said was proven (note/project/term/assurance/prove-loop).
// The reading is Term, check/law-english-reading.tree, and its header says how (item
// term-self-host-change-001-finish-self-host-0004). This face keeps the names its callers know, and the parse and the
// mill of `lawSentencesOf`, which run the build's own parser and mill.

import { parse } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { headWord } from '@term/make/code/compile/mill-run'
import * as port from '@term/make/code/check/law-english-reading'

export type LawKind = 'theorem' | 'axiom' | 'claim'

// one rule in words. `text` is absent exactly when `refused` says why. `words` lists each task the sentence names by
// its own name for want of a phrase, in order of first use
export type LawSentence = {
  name: string
  kind: LawKind
  text?: string
  refused?: string
  words: string[]
}

// every rule of a milled program in words, in the order written. A claim is filled by a task of its name, which is a
// separate statement and never read here: the sentence is the claim, not its proof
export function lawSentences(
  program: readonly unknown[],
): LawSentence[] {
  // the reading fills a need-false list it reads with its empty value (`??=`), so it is handed copies of the only
  // statements it reads, and the caller's program is never changed, as the original never changed it
  const functions = program
    .filter(s => (s as { form?: string }).form === 'function')
    .map(s => structuredClone(s))

  const read = port.lawSentences(functions as never) as unknown as {
    name: string
    kind: LawKind
    text: string
    refused: string
    words: string[]
  }[]

  return read.map(law =>
    law.refused === ''
      ? {
          name: law.name,
          kind: law.kind,
          text: law.text,
          words: law.words,
        }
      : {
          name: law.name,
          kind: law.kind,
          refused: law.refused,
          words: [],
        },
  )
}

export type LawSource = {
  file: string
  text: string
  role?: string
  lean?: boolean
}

// one `.tree` source to its rules in words, through the parser and the mill the build runs. A source that does not
// parse or mill returns the first diagnostic instead, and how many top-level `rule`s the parse tree holds, so a count
// over many files can say what a file it could not mill would have added
export function lawSentencesOf(
  source: LawSource,
):
  | { ok: true; laws: LawSentence[] }
  | { ok: false; error: string; rules: number } {
  const parsed = parse({ file: source.file, text: source.text })

  if (!parsed.ok) {
    return {
      ok: false,
      error: `parse: ${parsed.diagnostics[0]?.message ?? 'failed'}`,
      rules: 0,
    }
  }

  const built = mill(
    expandTemplates(parsed.tree),
    source.file,
    source.role,
    source.lean,
  )

  if (!built.ok) {
    const rules = parsed.tree.nodes.filter(
      node => node.kind === 'group' && headWord(node) === 'rule',
    ).length

    return {
      ok: false,
      error: `mill: ${built.diagnostics[0]?.message ?? 'failed'}`,
      rules,
    }
  }

  return { ok: true, laws: lawSentences(built.program) }
}
