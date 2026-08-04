// HTTP/2 stream runtime for node. `pushStream` is callback-based and its callback cannot be written inline in the
// seed source, so the promise wrapper lives here. Reached only through the public network API.
import type { ServerHttp2Stream } from 'node:http2'

const http2Stream = {
  // resolve with the pushed stream, or reject if the push was refused
  initiatePush: (
    stream: ServerHttp2Stream,
    headers: Record<string, string>,
  ): Promise<ServerHttp2Stream> =>
    new Promise((resolve, reject) => {
      stream.pushStream(headers, (error, pushed) => {
        if (error) {
          reject(error)
        } else {
          resolve(pushed)
        }
      })
    }),
}
