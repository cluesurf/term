// The node entry point for the Term language server: pump stdin and stdout through the protocol codec and the
// dispatcher. Editors launch this with `--stdio`. Everything interesting lives in server.ts (logic) and protocol.ts
// (framing); this file only owns the real streams.
//
// Three things it guarantees that a bare pump did not:
//
//   ONE MESSAGE AT A TIME, IN ORDER. Every chunk used to start its own async loop, so two edits arriving in two
//   chunks were analyzed concurrently and could finish in either order. Messages now go through one queue.
//
//   A CANCEL IS READ ON ARRIVAL, not when its turn comes, so a request still waiting in the queue is answered
//   RequestCancelled instead of being computed for an editor that no longer wants it.
//
//   NOTHING TAKES THE PROCESS DOWN. The dispatcher answers a failing request with an error itself, and anything that
//   still escapes is logged to stderr. A crashed server leaves the editor with no diagnostics and no word why.

import { LanguageServer } from '@term/flow/code/server'
import { MessageReader, encode } from '@term/flow/code/protocol'
import type { Message } from '@term/flow/code/protocol'

function write(message: Message): void {
  try {
    process.stdout.write(encode(message))
  } catch (error) {
    process.stderr.write(`term flow: could not write a message: ${String(error)}\n`)
  }
}

function main(): void {
  // diagnostics wait this long after the last keystroke, so a burst of typing is analyzed once
  const server = new LanguageServer({ debounce: 150, send: write })
  const reader = new MessageReader()
  const queue: Message[] = []

  let draining = false

  const drain = async (): Promise<void> => {
    if (draining) {
      return
    }

    draining = true

    try {
      while (queue.length > 0) {
        const message = queue.shift()!

        try {
          for (const outgoing of await server.dispatch(message)) {
            write(outgoing)
          }
        } catch (error) {
          // dispatch catches its own handlers; this is the last line, for a fault in the dispatcher itself
          process.stderr.write(`term flow: ${String((error as Error)?.stack ?? error)}\n`)

          if (message.id !== undefined && message.method !== undefined) {
            write({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32603, message: String((error as Error)?.message ?? error) },
            })
          }
        }

        if (message.method === 'exit') {
          // 0 after a shutdown request, 1 without one (the protocol's rule)
          process.exit(server.isShutDown() ? 0 : 1)
        }
      }
    } finally {
      draining = false
    }
  }

  process.stdin.on('data', (chunk: Buffer) => {
    for (const message of reader.append(chunk)) {
      if (message.method === '$/cancelRequest') {
        server.cancel((message.params as { id?: number | string } | null)?.id)
        continue
      }

      queue.push(message)
    }

    void drain()
  })

  // the editor closing the pipe is the end of the session
  process.stdin.on('end', () => process.exit(server.isShutDown() ? 0 : 1))

  process.on('uncaughtException', error => {
    process.stderr.write(`term flow: uncaught ${String(error?.stack ?? error)}\n`)
  })

  process.on('unhandledRejection', error => {
    process.stderr.write(`term flow: unhandled ${String((error as Error)?.stack ?? error)}\n`)
  })
}

main()
