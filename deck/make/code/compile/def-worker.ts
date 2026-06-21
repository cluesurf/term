// The per-definition worker entry (node, `worker_threads`). It caches the shared build context (sent once per
// revision) and, for each job, runs `processDef` (resolve + infer + emit one function) and posts the result back. The
// AST payloads are plain data, so the default structured-clone transfer carries them with no custom serializer. See
// note/seed/compiler/parallel-worker-pool.md.

import { parentPort, threadId } from 'node:worker_threads'
import { processDef } from '@cluesurf/make/code/compile/def-pass'
import type { DefContext } from '@cluesurf/make/code/compile/def-pass'
import type { Statement } from '@cluesurf/make/code/compile/node'

type FunctionDef = Extract<Statement, { form: 'function' }>

type ContextMessage = {
  type: 'context'
  revision: number
  context: DefContext
}
type JobMessage = {
  type: 'job'
  id: number
  revision: number
  source: FunctionDef
}
type InMessage = ContextMessage | JobMessage

let context: DefContext | undefined
let contextRevision = -1

parentPort?.on('message', (message: InMessage) => {
  if (message.type === 'context') {
    context = message.context
    contextRevision = message.revision

    return
  }

  // a job for a revision whose context we have not received: ask for it (self-healing; the pool normally sends the
  // context proactively before the first job of a revision, so this is a safety net)
  if (!context || contextRevision !== message.revision) {
    parentPort!.postMessage({ type: 'needContext', id: message.id })

    return
  }

  const output = processDef(message.source, context)
  parentPort!.postMessage({
    type: 'result',
    id: message.id,
    name: message.source.name,
    typed: output.typed,
    diagnostics: output.diagnostics,
    ts: output.ts,
    threadId,
  })
})
