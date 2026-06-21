// The node entry point for the Seed language server: pump stdin and stdout through the protocol codec and the
// dispatcher. Editors launch this with `--stdio`. Everything interesting lives in server.ts (logic) and protocol.ts
// (framing); this file only owns the real streams.

import { LanguageServer } from '@cluesurf/flow/code/server'
import {
  MessageReader,
  encode,
} from '@cluesurf/flow/code/protocol'

function main(): void {
  const server = new LanguageServer()
  const reader = new MessageReader()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    void (async () => {
      for (const message of reader.append(chunk)) {
        for (const outgoing of await server.dispatch(message))
          process.stdout.write(encode(outgoing))
        if (message.method === 'exit') process.exit(0)
      }
    })()
  })
}

main()
