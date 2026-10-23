// The one place @term/test reaches a solver: SMT-LIB2 text in, Z3's answer out. Everything around it (the formulas,
// their text, the queries, reading the answers, every algorithm built on them) is Term, in smt-query.tree and the
// modules that load it, which dock this as `load <global:smt-text>`.
//
// Z3 is the `z3-solver` package (WebAssembly), opened once on first use, so this runs on node. A native backend would
// hand the same text to a `z3` process; the text is the interface, which is why it is text (2026-10-05). The package is
// resolved from the working directory, because the module this is prepended to may be written anywhere (`term test`
// writes it to a temporary directory, where no package resolves).
//
// The script is copied to Z3's heap and freed only once the answer is back. The package's own `eval_smtlib2_string`
// passes it as a ccall 'string', which Emscripten writes on the main thread's stack and releases the moment ccall
// returns, while the call itself runs on a worker thread that reads the text later. Now and then the main thread
// reused that stack first, Z3 read a script cut short, and answered a valid query with `(error "... invalid
// s-expression, unexpected end of file")`: 3 in 10,000 queries on one context, 0 in 30,000 once copied
// (term-cli-in-term-0128, tmp/z3/probe.mjs and probe-heap.mjs). The line in that error is large because Z3 counts lines
// across every script a context reads; the count is harmless and is not the cause.
//
// An answer whose first line is an error is never handed on as an answer: the context is dropped and the query asked
// once more on a fresh one. A second error goes back as it is, and smt-query.tree's `check-sat` raises on it.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Emscripten = {
  _malloc: (size: number) => number
  _free: (at: number) => void
  HEAPU8: Uint8Array
  async_call: (run: () => void) => Promise<string>
  _async_Z3_eval_smtlib2_string: (context: number, at: number) => void
}

type Solver = {
  em: Emscripten
  Z3: Record<string, (...a: unknown[]) => unknown>
}

let smtSolver: Promise<Solver> | undefined
let smtContext: number | undefined

const encoder = new TextEncoder()

function freshContext(Z3: Solver['Z3']): number {
  return Z3.mk_context!(Z3.mk_config!()) as number
}

async function evaluateOn(solver: Solver, context: number, text: string): Promise<string> {
  const bytes = encoder.encode(text)
  const at = solver.em._malloc(bytes.length + 1)

  // HEAPU8 is read after the malloc, which may have grown the memory and replaced the view
  solver.em.HEAPU8.set(bytes, at)
  solver.em.HEAPU8[at + bytes.length] = 0

  try {
    return await solver.em.async_call(() => solver.em._async_Z3_eval_smtlib2_string(context, at))
  } finally {
    solver.em._free(at)
  }
}

function isErrorAnswer(answer: string): boolean {
  return answer.trimStart().startsWith('(error')
}

const smtText = {
  evaluate: async (text: string): Promise<string> => {
    smtSolver ??= (async () => {
      const found = createRequire(join(process.cwd(), 'noop.js')).resolve('z3-solver')
      const { init } = (await import(pathToFileURL(found).href)) as { init: () => Promise<Solver> }

      return init()
    })()

    const solver = await smtSolver

    smtContext ??= freshContext(solver.Z3)

    const answer = await evaluateOn(solver, smtContext, text)

    if (!isErrorAnswer(answer)) return answer

    solver.Z3.del_context!(smtContext)
    smtContext = freshContext(solver.Z3)

    return evaluateOn(solver, smtContext, text)
  },
}
