// node HTTP/HTTPS server runtime: start a server that reads each request, hands a normalized request object to the seed
// handler, and writes the handler's response. The opaque handle a seed `server` holds is the node `http.Server`. Reached
// only through the public network/server API. Mirrors the tcp / udp / websocket runtime shims.
import * as http from 'node:http'
import * as https from 'node:https'

type SeedRequest = {
  method: string
  url: string
  path: string
  query: string
  headers: Record<string, string | string[] | undefined>
  body: string
  dock: http.IncomingMessage
}

type SeedResponse = {
  status?: number
  headers?: Array<{ name: string; value: string }>
  body?: string
}

type Handler = (request: SeedRequest) => SeedResponse | Promise<SeedResponse>

const server = {
  // start a server on (port, host); resolves to the listening http.Server. With secure, serves HTTPS from the PEM cert/key.
  start: (
    port: number,
    host: string,
    handler: Handler,
    secure: boolean,
    certificate: string,
    key: string,
  ): Promise<http.Server> =>
    new Promise(resolve => {
      const onRequest = (
        raw: http.IncomingMessage,
        res: http.ServerResponse,
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
            res.end(out.body ?? '')
          })
        })
      }

      const raw = secure
        ? https.createServer({ cert: certificate, key }, onRequest)
        : http.createServer(onRequest)

      raw.listen(port, host, () => resolve(raw))
    }),

  // stop a running server, resolving when its port is released
  stop: (raw: http.Server): Promise<void> =>
    new Promise(resolve => raw.close(() => resolve())),

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
