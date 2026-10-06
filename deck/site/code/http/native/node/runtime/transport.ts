// HTTP server runtime shim (node). Wraps hono + @hono/node-server in a flat namespace of total functions so the seed
// `native/node/serve` impl can dock it as `<global:transport>` without ever expressing `new Hono()` or the adapter
// plumbing. hono is the transport (it owns the socket + request/response objects); the uniform trie router
// (`handle-request`) still does all matching. The build prepends this prelude; nothing in userland imports hono.
import { Hono } from 'hono'
// aliased: the seed `serve` task is emitted into the same bundle scope, so the hono adapter must not shadow it
import { serve as honoServe } from '@hono/node-server'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

// tree/code (note/term/host/10-code.md): bytes on the wire, base64 inside the program, the way a binary asset
// already travels, since `request.body` and `response.body` are text. A request body is read as bytes, never as
// UTF-8 (which would corrupt it), and unpacked when it came as `Content-Encoding: zstd`, up to TREE_CODE_LIMIT. A
// response body is packed with Zstandard when the client accepts it and that makes it smaller
const TREE_CODE = 'application/tree+code'
const TREE_CODE_LIMIT = 64 * 1024 * 1024
const TREE_CODE_PACK_ABOVE = 256

function isTreeCode(type: string | undefined): boolean {
  return (type ?? '').toLowerCase().split(';')[0]?.trim() === TREE_CODE
}

function acceptsZstd(accept: string | undefined): boolean {
  return (accept ?? '')
    .toLowerCase()
    .split(',')
    .some(part => part.trim().split(';')[0] === 'zstd' && !/;\s*q=0(\.0*)?\s*$/.test(part.trim()))
}

type Request = { method: string; path: string; body: string; headers: Map<string, string>; query: Map<string, string> }
type Response = { status: number; body: string; headers?: Map<string, string> }
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

// in dev, send `Cache-Control: no-store` on every response so the browser NEVER serves a stale `look.css` / `boot.js` /
// page after a hot reload. Without it the browser heuristically caches CSS (no cache headers were sent), which made
// edits appear not to take effect ("stale cache"). Production keeps normal caching (content-hashed asset names handle
// busting there).
const NO_STORE =
  process.env.NODE_ENV !== 'production'
    ? { 'Cache-Control': 'no-store' }
    : {}

const transport = {
  // build a listener around one handle: hono catches every request, converts it to our `request`, runs the handle
  // (which runs the trie router), and writes the returned `response` back. Sync or async handles both work.
  createServer(handle: Handle): Listener {
    const app = new Hono()
    app.all('*', async context => {
      const url = new URL(context.req.url)
      let body = ''

      if (context.req.method !== 'GET' && context.req.method !== 'HEAD') {
        if (isTreeCode(context.req.header('content-type'))) {
          let raw = Buffer.from(await context.req.arrayBuffer())

          if ((context.req.header('content-encoding') ?? '').toLowerCase().trim() === 'zstd') {
            try {
              raw = zstdDecompressSync(raw, { maxOutputLength: TREE_CODE_LIMIT })
            } catch {
              // past the limit, or not Zstandard at all: refused before the handler sees it
              return context.body('', 413 as never, { ...NO_STORE })
            }
          }

          body = raw.toString('base64')
        } else {
          body = await context.req.text()
        }
      }
      // the request's headers by lower-case name, and its query string decoded, as the `request` form declares them
      const headers = new Map<string, string>()
      context.req.raw.headers.forEach((value, name) => headers.set(name.toLowerCase(), value))
      const query = new Map<string, string>(url.searchParams)
      const response = await handle({
        method: context.req.method,
        path: url.pathname,
        body,
        headers,
        query,
      })
      const out = response.body ?? ''
      const status = (response.status ?? 200) as never
      const code = response.status ?? 200

      // the headers the handler set, written as given. A `content-type` among them decides the type, ahead of the
      // guesses below
      const given: Record<string, string> = {}

      for (const [name, value] of response.headers ?? []) {
        given[name] = value
      }

      const typed = Object.keys(given).some(name => name.toLowerCase() === 'content-type')
      const givenType = Object.entries(given).find(([name]) => name.toLowerCase() === 'content-type')?.[1]

      // tree/code: the body is base64 inside the program and bytes on the wire, packed when the client takes zstd
      if (isTreeCode(givenType) && code !== 1 && !(code >= 300 && code < 400)) {
        const plain = Buffer.from(out, 'base64')
        const vary = { Vary: 'Accept-Encoding' }

        if (plain.length >= TREE_CODE_PACK_ABOVE && acceptsZstd(context.req.header('accept-encoding'))) {
          const packed = zstdCompressSync(plain)

          if (packed.length < plain.length) {
            return context.body(packed as never, status, { ...NO_STORE, ...given, ...vary, 'Content-Encoding': 'zstd' })
          }
        }

        return context.body(plain as never, status, { ...NO_STORE, ...given, ...vary })
      }

      if (typed && code !== 1 && !(code >= 300 && code < 400 && out)) {
        return context.body(out, status, { ...NO_STORE, ...given })
      }
      // a proxy resource route (e.g. /vibe.pdf) returns the sentinel status 1 with the source URL as the body: fetch it
      // and stream the bytes back through this origin (the page URL stays put), carrying the upstream content-type.
      if (code === 1 && out) {
        const upstream = await fetch(out)
        const buffer = Buffer.from(await upstream.arrayBuffer())
        const type =
          upstream.headers.get('content-type') ??
          'application/octet-stream'
        return context.body(buffer as never, 200 as never, {
          'Content-Type': type,
          ...NO_STORE,
        })
      }
      // a redirect resource route returns a 3xx with the target URL as the body -> issue a real redirect
      if (code >= 300 && code < 400 && out) {
        return context.redirect(out, code as never)
      }
      // static assets (served from /base/...) get a content-type by file extension, so a browser accepts a `.js` module
      // script (strict MIME) and applies `.css`. Required for external stylesheets / scripts to load.
      const ext = url.pathname.includes('.')
        ? url.pathname
            .slice(url.pathname.lastIndexOf('.') + 1)
            .toLowerCase()
        : ''
      const assetType = ASSET_TYPES[ext]
      if (assetType) {
        // a binary asset was carried as base64 text; decode it back to bytes so images / fonts / media serve intact
        if (BINARY_TYPES.has(ext))
          return context.body(
            Buffer.from(out, 'base64') as never,
            status,
            {
              'Content-Type': assetType,
              ...NO_STORE,
            },
          )
        return context.body(out, status, {
          'Content-Type': assetType,
          ...NO_STORE,
        })
      }
      // serve an HTML body with the right content-type so a browser renders it (the response carries no headers, so the
      // shape of the body is the signal); JSON / plain text fall through to hono's default text/plain
      const head = out.trimStart().slice(0, 14).toLowerCase()
      if (head.startsWith('<!doctype') || head.startsWith('<html'))
        return context.html(out, status, { ...NO_STORE, ...given })
      return context.body(out, status, { ...NO_STORE, ...given })
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
