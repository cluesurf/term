// The Language Server wire codec: Content-Length framed JSON-RPC 2.0, the transport every LSP client speaks. This
// layer is transport-agnostic (no stdin/stdout here): `encode` produces a framed string to write, and `MessageReader`
// accumulates incoming chunks and yields whole messages. The node entry point (main.ts) pumps the real streams.

export type Message = {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length

// frame a message for the wire
export function encode(message: Message): string {
  const body = JSON.stringify(message)

  return `Content-Length: ${byteLength(body)}\r\n\r\n${body}`
}

// accumulate raw chunks and surface complete messages as they arrive. The header's Content-Length is in bytes; this
// reader assumes the body is ASCII JSON (true for LSP traffic), so byte length equals string length.
export class MessageReader {
  private buffer = ''

  append(chunk: string): Message[] {
    this.buffer += chunk

    const out: Message[] = []

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')

      if (headerEnd < 0) {
        break
      }

      const header = this.buffer.slice(0, headerEnd)
      const match = /Content-Length:\s*(\d+)/i.exec(header)

      if (!match) {
        // malformed header: drop it and resync past the separator
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }

      const length = Number(match[1])
      const bodyStart = headerEnd + 4

      if (this.buffer.length - bodyStart < length) {
        break
      } // body not fully arrived yet

      const body = this.buffer.slice(bodyStart, bodyStart + length)
      this.buffer = this.buffer.slice(bodyStart + length)

      try {
        out.push(JSON.parse(body) as Message)
      } catch {
        // ignore an unparseable body and keep reading
      }
    }

    return out
  }
}
