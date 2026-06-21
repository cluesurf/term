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

// content-type by file extension, for static assets served from /base/... A `.js` module script needs the correct
// MIME (browsers enforce it strictly); a `.css` needs text/css to apply.
const ASSET_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  avif: 'image/avif',
  bmp: 'image/bmp',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
}

// binary asset extensions: the asset reader carries these as base64 (a text body can't hold raw bytes), so the
// transport decodes the body back into a real byte buffer before sending. Kept in sync with the reader's BINARY set.
const BINARY_TYPES = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'avif',
  'bmp',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'mov',
  'pdf',
  'wasm',
])

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
      // static assets (served from /base/...) get a content-type by file extension, so a browser accepts a `.js` module
      // script (strict MIME) and applies `.css`. Required for external stylesheets / scripts to load.
      const ext = url.pathname.includes('.')
        ? url.pathname.slice(url.pathname.lastIndexOf('.') + 1).toLowerCase()
        : ''
      const assetType = ASSET_TYPES[ext]
      if (assetType) {
        // a binary asset was carried as base64 text; decode it back to bytes so images / fonts / media serve intact
        if (BINARY_TYPES.has(ext))
          return context.body(Buffer.from(out, 'base64') as never, status, {
            'Content-Type': assetType,
          })
        return context.body(out, status, { 'Content-Type': assetType })
      }
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
