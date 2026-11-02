// The code role's grammar as compile/mill-running.tree reads it, written as one JSON text. task/term/mill-bundle.ts bakes
// this text beside the grammar's sources, and the compiler reads it back in a millisecond where parsing the sources took
// 115 ms of every process that mills a file (item 0757). task/term/mint-parity.ts holds the baked text equal to a fresh
// read, so a change to a reader or to the grammar shows as stale. Only those two tasks import this file.

import { readLeanRules, readMineGrammar, readMintGrammar } from '@term/make/code/compile/mill-running'
import { parse } from '@term/make/code/parser/tree'

export function grammarReadText(mineText: string, mintText: string): string {
  const mineParsed = parse({ file: 'code-mine.tree', text: mineText })
  const mintParsed = parse({ file: 'code-mint.tree', text: mintText })

  if (!mineParsed.ok || !mintParsed.ok) {
    throw new Error('the baked grammar does not parse')
  }

  return JSON.stringify({
    mine: [...readMineGrammar(mineParsed.tree)],
    mint: [...readMintGrammar(mintParsed.tree)],
    lean: readLeanRules(mineParsed.tree),
  })
}
