// node HTTP/HTTPS server runtime: start a server that reads each request, hands a normalized request object to the seed
// handler, and writes the handler's response. The opaque handle a seed `server` holds is the node `http.Server`. Reached
// only through the public network/server API. Mirrors the tcp / udp / websocket runtime shims.
// `nodeHttp`, not `http`: this shim is prepended beside the HTTP client's (`runtime/http.ts`, `const http`), and a
// program loading both `network/server` and `network/http` declared `http` twice, so it could not serve and fetch at
// once (guides: library/network, 2026-10-04)
import * as nodeHttp from 'node:http'
import * as nodeHttps from 'node:https'

type SeedRequest = {
  method: string
  url: string
  path: string
  query: string
  headers: Record<string, string | string[] | undefined>
  body: string
  dock: nodeHttp.IncomingMessage
}

// `data` is a bytes body (network/server/response): when it holds a byte it is sent as it is and `body` is not read
// (item term-self-host-001-1326)
type SeedResponse = {
  status?: number
  headers?: Array<{ name: string; value: string }>
  body?: string
  data?: Uint8Array
}

type Handler = (
  request: SeedRequest,
) => SeedResponse | Promise<SeedResponse>

const server = {
  // start a server on (port, host); resolves to the listening http.Server. With secure, serves HTTPS from the PEM cert/key.
  start: (
    port: number,
    host: string,
    handler: Handler,
    secure: boolean,
    certificate: string,
    key: string,
  ): Promise<nodeHttp.Server> =>
    new Promise(resolve => {
      const onRequest = (
        raw: nodeHttp.IncomingMessage,
        res: nodeHttp.ServerResponse,
      ): void => {
        const chunks: Buffer[] = []
        raw.on('data', chunk => chunks.push(chunk as Buffer))
        raw.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const url = new URL(raw.url ?? '/', 'http://localhost')
          const request: SeedRequest = {
            method: raw.method ?? 'GET',
            url: raw.url ?? '/',
            path: url.pathname,
            query: url.search.replace(/^\?/, ''),
            headers: raw.headers,
            body,
            dock: raw,
          }

          Promise.resolve(handler(request)).then(out => {
            // flatten the ordered header list to node's raw [name, value, ...] form, preserving order and duplicates
            const raw: string[] = []
            for (const header of out.headers ?? []) {
              raw.push(header.name, header.value)
            }
            res.writeHead(out.status ?? 200, raw)
            res.end(out.data && out.data.length > 0 ? out.data : (out.body ?? ''))
          })
        })
      }

      const raw = secure
        ? nodeHttps.createServer({ cert: certificate, key }, onRequest)
        : nodeHttp.createServer(onRequest)

      raw.listen(port, host, () => resolve(raw))
    }),

  // the port a listening server is bound to: the one the OS chose when `start` asked for port 0 (item
  // term-self-host-001-1326). A server that is not listening answers 0
  port: (raw: nodeHttp.Server): number => {
    const address = raw.address()

    return address !== null && typeof address === 'object' ? address.port : 0
  },

  // stop a running server, resolving when its port is released: close stops listening at once, and every kept-alive
  // connection with no request in flight is closed now rather than at its keep-alive timeout, which is what every
  // backend's stop does (item 1206). node 19 and later's close already closes them; saying it holds every node alike
  stop: (raw: nodeHttp.Server): Promise<void> =>
    new Promise(resolve => {
      raw.close(() => resolve())
      raw.closeIdleConnections()
    }),

  // start a server and keep the process alive (node's http.Server holds the event loop open while listening). The
  // portable `serve` entry point: fire-and-forget on node, a blocking accept loop on the compiled backends.
  // With secure, serves HTTPS from the PEM cert/key, the same three arguments `start` takes: the two entry points
  // differ in whether they hold the process, not in what they can serve.
  serve: (
    port: number,
    host: string,
    handler: Handler,
    secure: boolean,
    certificate: string,
    key: string,
  ): void => {
    void server.start(port, host, handler, secure, certificate, key)
  },
}
