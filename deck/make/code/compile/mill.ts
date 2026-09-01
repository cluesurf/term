// The mill: a parsed `.tree` file to the compiler's AST.
//
// TWO READERS LIVE HERE WHILE ONE REPLACES THE OTHER.
//
// `compile/mill-legacy.ts` is the hand-written mill, 5,300 lines that lower a parse tree by hand. It is what
// the compiler reads through today. `compile/mint-bridge.ts` is the replacement: the code role's own `mine`
// and `mint` grammars (deck/mill/code/code), run by the executor in `compile/mill-run.ts` and bridged onto the
// compiler's nodes. Bringing the language's own reader under the rule every other dialect already obeys is
// mill-self-hosting-0006, and the switch is mint-bridge-0004.
//
// WHY IT HAS NOT FLIPPED YET. It flipped once, on 2026-08-31, on the strength of full byte parity over every
// `.tree` file in all twelve packages, and `pnpm term:test` went from 247 pass / 0 fail to 140 / 107. The pool
// was wrong: the compiler does not only mill files, it mills source STRINGS the suites and tools write inline,
// and those use constructs no file in the tree contains. A corpus is not a language.
//
// So the measurement moved here, where every caller passes through. Two flags, and neither costs anything when
// it is off:
//
//   TERM_MILL_PARITY=1 TERM_MILL_PARITY_OUT=/tmp/parity.jsonl pnpm term:test
//
// runs BOTH readers on everything the compiler mills, from any caller, and records where they disagree. That is
// the pool the corpus missed.
//
//   TERM_MILL_GRAMMAR=1 pnpm term:test
//
// runs the SWITCH, without switching: every caller reads through the grammar path, and the gate says what
// breaks. The first attempt flipped the line and read 107 failures at once with no way to take them one at a
// time. This is that way. The line flips when this run is green and the parity gate is clean, and not before.
//
// The reader is folded into `CACHE_EPOCH`, so a run under either flag cannot leave its answers in the shared
// mill cache for an ordinary build to read back. See compile/cache.ts.

import { appendFileSync } from 'node:fs'
import type { RootNode } from '@term/make/code/parser/tree'
import { millByHand } from '@term/make/code/compile/mill-legacy'
import { millByGrammar } from '@term/make/code/compile/mint-bridge'
import type { MillResult } from '@term/make/code/compile/mill-legacy'
import {
  canonical,
  diffCanonical,
} from '@term/make/code/compile/program-json'

export type { MillResult } from '@term/make/code/compile/mill-legacy'

// the surface vocabulary, re-exported from its own module so the readers that import it from here keep working
export {
  BINARY_BUILTIN,
  UNARY_BUILTIN,
  HALT_WORDS,
} from '@term/make/code/compile/surface'

const PARITY = process.env.TERM_MILL_PARITY === '1'
const PARITY_OUT = process.env.TERM_MILL_PARITY_OUT
const GRAMMAR = process.env.TERM_MILL_GRAMMAR === '1'

// one line per disagreement, deduped by its shape, so a fixture compiled a thousand times reports once
const reported = new Set<string>()

function record(entry: {
  file: string
  at: string
  reason: string
}): void {
  const key = `${entry.file}|${entry.at}|${entry.reason}`

  if (reported.has(key)) {
    return
  }

  reported.add(key)

  const line = `${JSON.stringify(entry)}\n`

  if (PARITY_OUT) {
    appendFileSync(PARITY_OUT, line)
  } else {
    process.stdout.write(`mill-parity ${line}`)
  }
}

function compare(
  tree: RootNode,
  file: string,
  role: string | undefined,
  reference: MillResult,
): void {
  let built: MillResult

  try {
    built = millByGrammar(tree, file, role)
  } catch (cause) {
    record({ file, at: '(threw)', reason: String(cause).slice(0, 200) })

    return
  }

  // the hand-written reader refused it: the grammar path is not asked to agree about a file that does not read
  if (!reference.ok) {
    return
  }

  if (!built.ok) {
    record({
      file,
      at: '(refused)',
      reason: built.diagnostics[0]?.message ?? 'no diagnostic',
    })

    return
  }

  for (const difference of diffCanonical(
    canonical(reference.program),
    canonical(built.program),
    3,
  )) {
    record({
      file,
      at: difference.path,
      reason: `${difference.left} != ${difference.right}`,
    })
  }
}

export function mill(
  tree: RootNode,
  file: string,
  role?: string,
): MillResult {
  if (GRAMMAR) {
    return millByGrammar(tree, file, role)
  }

  const reference = millByHand(tree, file, role)

  if (PARITY) {
    compare(tree, file, role, reference)
  }

  return reference
}
