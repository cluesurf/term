// The one place @term/test reaches a solver: SMT-LIB2 text in, Z3's answer out. Everything around it (the formulas,
// their text, the queries, reading the answers, every algorithm built on them) is Term, in smt-query.tree and the
// modules that load it, which dock this as `load <global:smt-text>`.
//
// Z3 is the `z3-solver` package (WebAssembly), opened once on first use, so this runs on node. A native backend would
// hand the same text to a `z3` process; the text is the interface, which is why it is text (2026-10-05). The package is
// resolved from the working directory, because the module this is prepended to may be written anywhere (`term test`
// writes it to a temporary directory, where no package resolves).
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let smtContext: Promise<(text: string) => Promise<string>> | undefined

const smtText = {
  evaluate: async (text: string): Promise<string> => {
    smtContext ??= (async () => {
      const found = createRequire(join(process.cwd(), 'noop.js')).resolve('z3-solver')
      const { init } = (await import(pathToFileURL(found).href)) as { init: () => Promise<{ Z3: Record<string, (...a: unknown[]) => unknown> }> }
      const { Z3 } = await init()
      const ctx = Z3.mk_context!(Z3.mk_config!())

      return (query: string) => Z3.eval_smtlib2_string!(ctx, query) as Promise<string>
    })()

    return (await smtContext)(text)
  },
}
