// HTTP/2 server runtime for node, over `node:http2`.
//
// TWO WAYS IN, and node has a constructor for each:
//
//   secure   `createSecureServer`, TLS with ALPN advertising h2. The only way a browser speaks HTTP/2.
//   clear    `createServer`, h2c with prior knowledge: no ALPN, no upgrade dance.
//
// node is the one backend where HTTP/2 was already reachable, and it was reachable as a mill macro that nothing
// imported and that two empty files belonged to. This is the same surface the other three have.
//
// Reached only through the public network/http2 API.
import * as http2 from 'node:http2'

type SeedRequest = {
  method: string
  url: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
  dock: unknown
}

type SeedResponse = {
  status?: number
  headers?: Array<{ name: string; value: string }>
  body?: string
}

type Handler = (request: SeedRequest) => SeedResponse | Promise<SeedResponse>

type Running = { server: http2.Http2Server | undefined; port: number }

// RFC 9113 forbids these; a response carrying one is malformed and node throws on it
const CONNECTION_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
])

const http2Runtime = {
  serve: (
    port: number,
    host: string,
    handler: Handler,
    secure: boolean,
    certificate: string,
    key: string,
  ): void => {
    void http2Runtime.start(port, host, handler, secure, certificate, key)
  },

  start: async (
    port: number,
    host: string,
    handler: Handler,
    secure: boolean,
    certificate: string,
    key: string,
  ): Promise<Running> => {
    const scheme = secure ? 'https' : 'http'
    const onStream = (
      stream: http2.ServerHttp2Stream,
      headers: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader,
    ): void => {
      void answer(stream, headers, handler, scheme)
    }

    const server = secure
      ? http2.createSecureServer({ cert: certificate, key, allowHTTP1: true })
      : http2.createServer()

    server.on('stream', onStream)

    await new Promise<void>(ready => {
      server.listen(port, host, () => ready())
    })

    return { server, port }
  },

  stop: async (running: Running): Promise<void> => {
    const server = running.server
    running.server = undefined

    if (!server) {
      return
    }

    await new Promise<void>(done => {
      server.close(() => done())
    })
  },
}

async function answer(
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  handler: Handler,
  scheme: string,
): Promise<void> {
  const target = String(headers[':path'] ?? '/')
  const split = target.indexOf('?')
  const path = split >= 0 ? target.slice(0, split) : target

  const flat: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    flat[name.toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value ?? '')
  }

  // the pseudo-headers node already gives us, plus the stream id it does expose (unlike the other three)
  flat[':scheme'] = String(headers[':scheme'] ?? scheme)
  flat[':authority'] = String(headers[':authority'] ?? flat['host'] ?? '')
  flat[':path'] = target
  flat['x-term-stream'] = String(stream.id ?? 0)

  const body = await new Promise<string>(done => {
    const parts: Buffer[] = []
    stream.on('data', (chunk: Buffer) => parts.push(chunk))
    stream.on('end', () => done(Buffer.concat(parts).toString('utf8')))
    stream.on('error', () => done(''))
  })

  let answered: SeedResponse

  try {
    answered = await handler({
      method: String(headers[':method'] ?? 'GET'),
      url: target,
      path,
      query: split >= 0 ? target.slice(split + 1) : '',
      headers: flat,
      body,
      dock: stream,
    })
  } catch {
    answered = { status: 500, body: '' }
  }

  const out: Record<string, string | string[]> = {
    ':status': String(answered.status ?? 200),
  }

  for (const header of answered.headers ?? []) {
    if (CONNECTION_HEADERS.has(header.name.toLowerCase())) {
      continue
    }

    const already = out[header.name]

    // repeats survive, which is what several set-cookie headers needs
    if (already === undefined) {
      out[header.name] = header.value
    } else if (Array.isArray(already)) {
      already.push(header.value)
    } else {
      out[header.name] = [already, header.value]
    }
  }

  try {
    stream.respond(out)
    stream.end(answered.body ?? '')
  } catch {
    stream.close()
  }
}
