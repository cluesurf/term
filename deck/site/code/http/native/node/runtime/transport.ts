// HTTP server runtime shim (node). Wraps hono + @hono/node-server in a flat namespace of total functions so the seed
// `native/node/serve` impl can dock it as `<global:transport>` without ever expressing `new Hono()` or the adapter
// plumbing. hono is the transport (it owns the socket + request/response objects); the uniform trie router
// (`handle-request`) still does all matching. The build prepends this prelude; nothing in userland imports hono.
import { Hono } from 'hono'
// aliased: the seed `serve` task is emitted into the same bundle scope, so the hono adapter must not shadow it
import { serve as honoServe } from '@hono/node-server'

type Request = { method: string; path: string; body: string }
type Response = { status: number; body: string }
type Handle = (request: Request) => Response | Promise<Response>
type Listener = { handle: Handle; close(): void }

const transport = {
  // build a listener around one handle: hono catches every request, converts it to our `request`, runs the handle
  // (which runs the trie router), and writes the returned `response` back. Sync or async handles both work.
  createServer(handle: Handle): Listener {
    const app = new Hono()
    app.all('*', async (context) => {
      const url = new URL(context.req.url)
      const body = context.req.method === 'GET' || context.req.method === 'HEAD' ? '' : await context.req.text()
      const response = await handle({ method: context.req.method, path: url.pathname, body })
      const out = response.body ?? ''
      const status = (response.status ?? 200) as never
      // serve an HTML body with the right content-type so a browser renders it (the response carries no headers, so the
      // shape of the body is the signal); JSON / plain text fall through to hono's default text/plain
      const head = out.trimStart().slice(0, 14).toLowerCase()
      if (head.startsWith('<!doctype') || head.startsWith('<html'))
        return context.html(out, status)
      return context.body(out, status)
    })
    let server: ReturnType<typeof honoServe> | null = null
    return {
      handle,
      listen(port: number): void {
        server = honoServe({ fetch: app.fetch, port })
      },
      close(): void {
        server?.close()
        server = null
      },
    } as Listener & { listen(port: number): void }
  },
}
