// HTTP exchanges over the host fetch, held by number. `open` sends the request, its body as bytes (none when empty),
// redirects followed only under `follow` (else fetch's `manual`, which on node answers the redirect as it is), and
// answers `ok`, the exchange's number, the status, then each response header as a lower-case name and its value; or
// `timeout` / `outage` and the host's message. The body stays unread: `read` takes up to `room` bytes of it, `fault`
// says after each read whether it broke off (and lets go of an exchange whose body ended), `cancel` lets it go
// unread. The time limit is fetch's signal, so it holds over the body's reads too. The public http module
// (base/code/network/http.tree) raises from these, so every backend answers alike.

type HttpExchangeHeld = {
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  done: boolean
  fault: string[]
}

const httpExchangeHeld = new Map<number, HttpExchangeHeld>()
let httpExchangeNext = 0

// a timeout is the signal's TimeoutError (or the AbortError of an older node), anything else an outage
const httpExchangeFailed = (problem: unknown): string[] => {
  const name = (problem as { name?: unknown } | null)?.name
  const kind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'outage'
  return [kind, String(problem)]
}

const httpExchange = {
  open: async (
    method: string,
    url: string,
    body: Uint8Array,
    header: Map<string, string>,
    timeout: number,
    follow: boolean,
  ): Promise<string[]> => {
    const init: RequestInit = {
      method,
      headers: Object.fromEntries(header),
      signal: AbortSignal.timeout(Math.max(0, timeout)),
      redirect: follow ? 'follow' : 'manual',
    }
    if (body.length > 0) {
      init.body = body
    }
    try {
      const response = await fetch(url, init)
      httpExchangeNext += 1
      const ticket = httpExchangeNext
      httpExchangeHeld.set(ticket, {
        reader: response.body === null ? undefined : response.body.getReader(),
        done: false,
        fault: ['', ''],
      })
      const out = ['ok', String(ticket), String(response.status)]
      response.headers.forEach((value, name) => {
        out.push(name.toLowerCase(), value)
      })
      return out
    } catch (problem) {
      return httpExchangeFailed(problem)
    }
  },

  read: async (ticket: number, room: number): Promise<Uint8Array> => {
    const held = httpExchangeHeld.get(ticket)
    if (held === undefined) {
      return new Uint8Array(0)
    }
    // a body already read to its end, asked again: gone, as `fault` then says
    if (held.done) {
      httpExchangeHeld.delete(ticket)
      return new Uint8Array(0)
    }
    const parts: Uint8Array[] = []
    let total = 0
    try {
      while (held.reader !== undefined && total < room) {
        const chunk = await held.reader.read()
        if (chunk.done) {
          held.reader = undefined
          break
        }
        parts.push(chunk.value)
        total += chunk.value.length
      }
    } catch (problem) {
      held.fault = httpExchangeFailed(problem)
      held.reader = undefined
    }
    if (held.reader === undefined) {
      held.done = true
    }
    const out = new Uint8Array(Math.min(total, Math.max(0, room)))
    let at = 0
    for (const part of parts) {
      if (at >= out.length) {
        break
      }
      const take = part.subarray(0, out.length - at)
      out.set(take, at)
      at += take.length
    }
    return out
  },

  fault: (ticket: number): string[] => {
    const held = httpExchangeHeld.get(ticket)
    if (held === undefined) {
      return ['gone', `no exchange ${ticket} is held`]
    }
    if (held.done) {
      httpExchangeHeld.delete(ticket)
    }
    return held.fault
  },

  cancel: (ticket: number): void => {
    const held = httpExchangeHeld.get(ticket)
    httpExchangeHeld.delete(ticket)
    if (held?.reader !== undefined) {
      held.reader.cancel().catch(() => undefined)
    }
  },
}
