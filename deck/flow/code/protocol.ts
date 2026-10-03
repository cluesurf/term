// The Language Server wire codec: Content-Length framed JSON-RPC 2.0, the transport every LSP client speaks. This
// layer is transport-agnostic (no stdin/stdout here): `encode` produces a framed string to write, and `MessageReader`
// accumulates incoming chunks and yields whole messages. The node entry point (main.ts) pumps the real streams.

export type Message = {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

const byteLength = (text: string): number => encoder.encode(text).length

// frame a message for the wire
export function encode(message: Message): string {
  const body = JSON.stringify(message)

  return `Content-Length: ${byteLength(body)}\r\n\r\n${body}`
}

// the header/body separator, as bytes
const SEPARATOR = [13, 10, 13, 10]

function indexOfSeparator(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === SEPARATOR[0] &&
      bytes[i + 1] === SEPARATOR[1] &&
      bytes[i + 2] === SEPARATOR[2] &&
      bytes[i + 3] === SEPARATOR[3]
    ) {
      return i
    }
  }

  return -1
}

// Accumulate raw chunks and surface complete messages as they arrive.
//
// THE BUFFER IS BYTES. The header's Content-Length counts the body in UTF-8 bytes, and a Term document holds Greek,
// CJK and emoji, so a body is routinely longer in bytes than in UTF-16 characters. This reader used to keep a string
// and slice `length` characters, which on any non-ASCII body read past its end into the next message's header and
// lost that message. A string chunk is still accepted (the tests frame with `encode`) and is encoded first.
export class MessageReader {
  private buffer: Uint8Array = new Uint8Array(0)

  append(chunk: string | Uint8Array): Message[] {
    const incoming = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    const joined = new Uint8Array(this.buffer.length + incoming.length)
    joined.set(this.buffer, 0)
    joined.set(incoming, this.buffer.length)
    this.buffer = joined

    const out: Message[] = []

    for (;;) {
      const headerEnd = indexOfSeparator(this.buffer, 0)

      if (headerEnd < 0) {
        break
      }

      const header = decoder.decode(this.buffer.subarray(0, headerEnd))
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

      const body = decoder.decode(
        this.buffer.subarray(bodyStart, bodyStart + length),
      )

      this.buffer = this.buffer.slice(bodyStart + length)

      try {
        const parsed = JSON.parse(body) as unknown

        // a body that is JSON but not an object (a number, a string, null) is not a message
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          out.push(parsed as Message)
        }
      } catch {
        // ignore an unparseable body and keep reading
      }
    }

    return out
  }
}
