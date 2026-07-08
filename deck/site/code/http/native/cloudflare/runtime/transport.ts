// HTTP transport shim (Cloudflare Workers). Docked as `<global:transport>` by the Worker
// `native/cloudflare/serve` impl, exactly as the node transport is docked by `native/node/serve`.
// The difference is the runtime model: a Worker never owns a socket, so instead of `createServer`
// + `.listen(port)`, this exposes `create-fetch(handle)`, which returns a Web-standard
// `{ fetch(request, env, ctx) }` object. The Workers runtime invokes that `fetch` per request. The
// uniform trie router (`handle`) still does every match; this shim only bridges the Web Request /
// Response objects to our `{ method, path, body }` / `{ status, body }` shapes, mirroring the node
// transport's content-type-by-extension, proxy (status 1), and redirect (3xx) handling.
//
// Static assets (`/base/**`) are delegated to the Worker's ASSETS binding (`env.ASSETS`), stripping
// the `/base` prefix so `/base/boot.js` maps to the `build/boot.js` the assets binding serves. This
// replaces the node host's `<global:assets>` filesystem read (there is no filesystem on a Worker).

type TermRequest = { method: string; path: string; body: string }
type TermResponse = { status: number; body: string }
type Handle = (request: TermRequest) => TermResponse | Promise<TermResponse>

// content-type by file extension, for any body served with a known asset extension. A `.js` module
// script needs the correct MIME (browsers enforce it strictly); a `.css` needs text/css to apply.
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

// binary asset extensions: a binary body arrives as base64 text (the router's `response.body` is a
// text field), so decode it back into real bytes before responding. Kept in sync with the node set.
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

// decode a base64 string into a byte array (Workers have `atob`, but not node's Buffer by default)
function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// the exported NAMESPACE is `transport` (matching the `<global:transport>` dock); the seed
// `native/cloudflare/serve` docks it as `name runtime`, so `.tree` calls `runtime/create-fetch`.
export const transport = {
  // wrap one router `handle` in a Web fetch handler. The Workers runtime calls `fetch` per request;
  // `env` carries the Worker bindings (notably `ASSETS`). Returns the object the app's `boot` yields
  // and the emitted Worker entry re-exports as `export default`.
  createFetch(handle: Handle) {
    return {
      async fetch(
        request: Request,
        env: { ASSETS?: { fetch(request: Request): Promise<Response> } },
        _context: unknown,
      ): Promise<Response> {
        const url = new URL(request.url)

        // static assets: delegate `/base/**` to the ASSETS binding, stripping the `/base` prefix so
        // `/base/boot.js` resolves to the `build/boot.js` the binding serves.
        if (url.pathname === '/base' || url.pathname.startsWith('/base/')) {
          const assets = env && env.ASSETS

          if (assets && typeof assets.fetch === 'function') {
            const stripped = url.pathname.slice('/base'.length) || '/'
            const assetUrl = new URL(stripped + url.search, url.origin)
            return assets.fetch(new Request(assetUrl.toString(), request))
          }

          return new Response('', { status: 404 })
        }

        // the router registers GET routes; a HEAD is a GET without a response body (browsers navigate
        // with GET, but health checks / crawlers may HEAD), so dispatch it as GET. The full body is
        // kept so the content-type is computed correctly; the Workers runtime strips it for a HEAD.
        const method = request.method === 'HEAD' ? 'GET' : request.method
        const body =
          method === 'GET' || method === 'HEAD' ? '' : await request.text()

        const response = await handle({ method, path: url.pathname, body })
        const out = response.body ?? ''
        const code = response.status ?? 200

        // proxy sentinel (status 1): fetch the upstream URL and stream its bytes through this origin
        // (the page URL stays put), carrying the upstream content-type.
        if (code === 1 && out) {
          const upstream = await fetch(out)
          const type =
            upstream.headers.get('content-type') ??
            'application/octet-stream'
          return new Response(upstream.body, {
            status: 200,
            headers: { 'Content-Type': type },
          })
        }

        // a redirect resource route returns a 3xx with the target URL as the body -> a real redirect
        if (code >= 300 && code < 400 && out) {
          return new Response(null, {
            status: code,
            headers: { Location: out },
          })
        }

        // a body carrying a known asset extension gets the right content-type (parity with node; the
        // primary asset path is the ASSETS binding above, this covers any router-served file bytes)
        const dot = url.pathname.lastIndexOf('.')
        const ext = dot >= 0 ? url.pathname.slice(dot + 1).toLowerCase() : ''
        const assetType = ASSET_TYPES[ext]

        if (assetType) {
          if (BINARY_TYPES.has(ext)) {
            return new Response(base64ToBytes(out), {
              status: 200,
              headers: { 'Content-Type': assetType },
            })
          }

          return new Response(out, {
            status: code,
            headers: { 'Content-Type': assetType },
          })
        }

        // the SSR page (an HTML body) -> text/html so the browser renders it
        const head = out.trimStart().slice(0, 14).toLowerCase()

        if (head.startsWith('<!doctype') || head.startsWith('<html')) {
          return new Response(out, {
            status: code,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }

        return new Response(out, { status: code })
      },
    }
  },
}
