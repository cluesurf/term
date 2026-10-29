// A face over framing.tree, the port of this module (term-cli-in-term-0097, live since term-cli-in-term-0117): the
// Content-Length codec of the language server's wire. The original is kept at tmp/retired/flow/protocol.ts. Its
// TypeScript callers (test/server/run.ts, keystroke.ts, current.ts) keep this API until they move to the port's.
import * as emitted from '@term/flow/code/framing'

// deck/flow/package.json is the VS Code manifest and says no `"type": "module"`, so under tsx the emitted port loads
// as CommonJS and an ESM importer may see its exports under `default`
const port = ((emitted as { default?: unknown }).default ??
  emitted) as any

export type Message = {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export function encode(message: Message): string {
  return port.encode(message)
}

export class MessageReader {
  private reader = port.makeReader()

  append(chunk: string | Uint8Array): Message[] {
    return typeof chunk === 'string'
      ? port.appendText(this.reader, chunk)
      : port.appendBytes(this.reader, chunk)
  }
}
