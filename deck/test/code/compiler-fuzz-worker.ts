/**
 * The worker side of the compiler fuzzer: it compiles one `.tree` source
 * per message and posts back the outcome. Run in a worker thread so the
 * parent can enforce a per-compile TIMEOUT - a malformed input that
 * sends the compiler into an infinite loop is a robustness bug just as
 * real as a crash, and only an out-of-process watchdog can catch it (a
 * synchronous hang cannot be interrupted in-thread). On timeout the
 * parent terminates this worker and records a "hang" finding.
 */

import { parentPort } from 'node:worker_threads'
import { compile } from '@term/make/code/compile/compile'

parentPort?.on('message', (text: string) => {
  try {
    const r = compile({ file: 'fuzz.tree', text }, { resolve: () => undefined })
    const diags = r.ok ? r.warnings : r.diagnostics
    parentPort?.postMessage({ kind: 'ok', codes: (diags ?? []).map(d => d.code) })
  } catch (error) {
    parentPort?.postMessage({
      kind: 'crash',
      error: error instanceof Error ? `${error.message}` : String(error),
    })
  }
})
