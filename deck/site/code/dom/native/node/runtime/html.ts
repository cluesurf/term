// Runtime shim for server-side rendering: serialize the in-memory DOM tree (the node dom's `element` record) to an
// HTML string, and wrap a body in the document shell. Provided via <global:html>; the build prepends it next to the
// node dom impl that docks it (`dock load <global:html> name doc`, emitted as `const doc = html`, so the dom calls
// `doc.serializeNode` / `doc.documentShell`). The exported NAMESPACE is `html` (an object) -- distinct from the dom's
// own `serialize` / `page-shell` task names, so there is no duplicate-declaration collision when both are bundled.
// Walking the record in TS keeps the `<`, `>`, `"` HTML literals out of the `.tree` text-delimiter and gives correct
// escaping + void-element handling. A text node has an empty `tag`; an element has children (each a view wrapping its
// own record).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// per-render SEO metadata, set by the matched route (via the dom `set-title` / `set-meta` tasks) and drained by
// `documentShell` into the <head>. SSR render is synchronous per request (route -> serialize -> shell, no await
// between), so a single module slot is safe: each request fills it, the shell reads + clears it. This is how a route's
// `seed title <...>` / `seed description <...>` directives reach the server-rendered <head>, declared separately from
// the component (Remix-style).
let pendingTitle: string | undefined
const pendingMeta: { name: string; content: string }[] = []

function resetMeta(): void {
  pendingTitle = undefined
  pendingMeta.length = 0
}

// named `stash*` (not `setTitle` / `setMeta`) so these top-level helpers do not collide with the node dom's own
// `set-title` / `set-meta` task emissions when concatenated into the bundle; the `html` namespace re-exposes them under
// the `setTitle` / `setMeta` keys the dom calls (`doc.setTitle` / `doc.setMeta`).
function stashTitle(title: string): void {
  pendingTitle = title
}

// a per-request proxy source set by a resource route (e.g. /vibe.pdf). The host reads it after dispatch and, if set,
// fetches + streams that URL's bytes instead of rendering. Read-and-clear so it never leaks to the next request.
let pendingProxy: string | undefined

function stashProxy(url: string): void {
  pendingProxy = url
}

function takeProxy(): string {
  const url = pendingProxy ?? ''
  pendingProxy = undefined

  return url
}

function stashMeta(name: string, content: string): void {
  // last write wins for a given name, so a route can override a default
  const existing = pendingMeta.find(m => m.name === name)

  if (existing) {
    existing.content = content
  } else {
    pendingMeta.push({ name, content })
  }
}

// The lowered route dispatcher calls `setTitle` / `setMeta` / `setProxy` at the
// top level (from a route's `seed title` / `seed description` / proxy
// directives). On the browser these resolve to the dom's own tasks; on the
// server the node dom's task emissions are not linked into the boot bundle, so
// provide them here as top-level helpers that drain into the SSR <head> via the
// stash. The route references them, so the bundler retains them.
function setTitle(title: string): void {
  stashTitle(title)
}

function setMeta(name: string, content: string): void {
  stashMeta(name, content)
}

function setProxy(url: string): void {
  stashProxy(url)
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

// coerce to string first: an attribute / text value may be a number (e.g. an `<img width>` bound to a numeric getter),
// the way React accepts `width={256}`. String() keeps the serializer total instead of throwing on `.replace`.
function escapeText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
}

type Element = {
  tag: string
  text: string
  attributes: { name: string; value: string }[]
  classes: string[]
  children: { handle: Element }[]
}

// HTML output mode. Default: PRETTY in dev (indented, nice View-Source), COMPACT in prod (smallest payload). Override
// either way explicitly: `SEED_HTML=pretty` forces pretty (even in prod), `SEED_HTML=compact` forces compact (even in
// dev). Pretty is whitespace-SAFE: an element whose children include a text node (inline content like `<p>... <a>x</a>
// ...`) stays compact, so no rendered whitespace is introduced; only all-element ("block") parents break onto lines.
const PRETTY =
  process.env.SEED_HTML === 'pretty'
    ? true
    : process.env.SEED_HTML === 'compact'
      ? false
      : process.env.NODE_ENV !== 'production'

// the asset manifest maps a logical build path (`style/look.css`, `boot.js`) to its content-hashed name
// (`style/look-mndb-tksh.css`) for production cache-busting. The prod build writes `build/asset-manifest.json`; in dev
// there is none, so every path resolves to itself (stable, easy to refresh). Read once per process, then memoized.
let manifest: Record<string, string> | null | undefined

function assetMap(): Record<string, string> | null {
  if (manifest !== undefined) {
    return manifest
  }

  try {
    const file = join(process.cwd(), 'build', 'asset-manifest.json')
    manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      string
    >
  } catch {
    manifest = null
  }

  return manifest
}

// the dev build id (build/__id, bumped on every rebuild) used as a `?v=` cache-buster, read fresh per request so a
// rebuild changes the URL and the browser cannot serve a stale css/js even if it ignored Cache-Control.
function buildVersion(): string {
  try {
    return readFileSync(
      join(process.cwd(), 'build', '__id'),
      'utf8',
    ).trim()
  } catch {
    return ''
  }
}

// resolve a logical asset path to its public `/base/...` URL. Prod uses the content-hashed name (the manifest); dev
// appends `?v=<build-id>` so an edit always wins over the browser cache.
function assetUrl(logical: string): string {
  const map = assetMap()
  const resolved = (map && map[logical]) || logical
  const base = `/base/${resolved}`

  if (process.env.NODE_ENV !== 'production') {
    return `${base}?v=${buildVersion()}`
  }

  return base
}

// the client bundle externalizes its third-party (npm) deps and loads them via a web-standard import map (so the app
// needs no local install of its browser deps). The build writes `build/import-map.json`; the shell inlines it as an
// `<script type="importmap">` BEFORE the module script (an import map must precede the first module that uses it). No
// deps -> no tag. Read once, memoized.
let importMapTag: string | undefined

function importMapScript(): string {
  if (importMapTag !== undefined) {
    return importMapTag
  }

  try {
    const file = join(process.cwd(), 'build', 'import-map.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      imports?: Record<string, string>
    }

    importMapTag =
      parsed.imports && Object.keys(parsed.imports).length
        ? `<script type="importmap">${JSON.stringify(parsed)}</script>`
        : ''
  } catch {
    importMapTag = ''
  }

  return importMapTag
}

// dev live-reload: a tiny inline poller that watches `/base/__id` (bumped by the server on every style rebuild) and
// reloads the page when it changes -- so an edit shows in the browser with no manual refresh. Dev only (off in prod).
const DEV = process.env.NODE_ENV !== 'production'

function devReloadScript(): string {
  if (!DEV) {
    return ''
  }

  return (
    '<script>(function(){var id;function p(){fetch("/base/__id",{cache:"no-store"})' +
    '.then(function(r){return r.text()}).then(function(t){if(id===undefined){id=t}' +
    'else if(t!==id){location.reload()}}).catch(function(){})}setInterval(p,500)})()</script>'
  )
}

function elementOf(node: { handle?: Element } | Element): Element {
  return (
    'handle' in node && node.handle ? node.handle : node
  ) as Element
}

function openTag(el: Element): string {
  const classAttr = el.classes?.length
    ? ` class="${escapeAttr(el.classes.join(' '))}"`
    : ''

  const attrs = (el.attributes ?? [])
    .map(attr => ` ${attr.name}="${escapeAttr(attr.value)}"`)
    .join('')

  return `<${el.tag}${classAttr}${attrs}>`
}

// compact serialization: no added whitespace (correct for inline content + prod)
function compactNode(node: { handle?: Element } | Element): string {
  const el = elementOf(node)

  if (!el.tag) {
    return escapeText(el.text ?? '')
  }

  const open = openTag(el)

  if (VOID.has(el.tag)) {
    return open
  }

  const children = (el.children ?? []).map(compactNode).join('')

  return `${open}${children}</${el.tag}>`
}

// pretty serialization: indent block elements; keep inline (has-text) content compact
function prettyNode(
  node: { handle?: Element } | Element,
  depth: number,
): string {
  const el = elementOf(node)

  if (!el.tag) {
    return escapeText(el.text ?? '')
  }

  const pad = '  '.repeat(depth)
  const open = openTag(el)

  if (VOID.has(el.tag)) {
    return pad + open
  }

  const children = el.children ?? []

  if (children.length === 0) {
    return `${pad}${open}</${el.tag}>`
  }

  // inline content (any text child): render the subtree compact on one line, so no whitespace is introduced
  if (children.some(child => !elementOf(child).tag)) {
    return `${pad}${open}${children.map(compactNode).join('')}</${el.tag}>`
  }

  // block content (all elements): each child on its own indented line
  const inner = children
    .map(child => prettyNode(child, depth + 1))
    .join('\n')

  return `${pad}${open}\n${inner}\n${pad}</${el.tag}>`
}

function serializeNode(node: { handle?: Element } | Element): string {
  return PRETTY ? prettyNode(node, 0) : compactNode(node)
}

// render one <meta> tag from a route descriptor. og:* / article:* use `property=` (Open Graph spec); everything else
// (description, twitter:*, theme-color, ...) uses `name=`. This is where a route's `seed description <...>` etc. lands.
function metaTag(name: string, content: string): string {
  const attr =
    name.startsWith('og:') || name.startsWith('article:')
      ? 'property'
      : 'name'

  return `<meta ${attr}="${escapeAttr(name)}" content="${escapeAttr(content)}">`
}

// the document shell links the stylesheet as an EXTERNAL file and loads the client bundle as a module script (both
// served by the host's static `/base/` route, cacheable, not re-sent per page). The script makes the server-rendered
// page interactive: on load it takes over the body and the reactive runtime keeps it live. Prod uses content-hashed
// names (via the asset manifest); dev uses the stable paths. The per-route SEO meta (title + tags) set during render
// is drained into the <head> here, then the slot is cleared for the next request.
function documentShell(
  body: string,
  fallbackTitle = 'ClueSurf',
): string {
  const styleHref = assetUrl('style/look.css')
  const scriptSrc = assetUrl('boot.js')
  const importMap = importMapScript()
  const title = pendingTitle ?? fallbackTitle
  const tags = pendingMeta.map(m => metaTag(m.name, m.content))
  resetMeta()

  if (!PRETTY) {
    return (
      '<!doctype html><html lang="en"><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<link rel="icon" href="/base/logo.svg">' +
      `<title>${escapeText(title)}</title>` +
      tags.join('') +
      `<link rel="stylesheet" href="${styleHref}">` +
      importMap +
      `<script type="module" src="${scriptSrc}"></script>` +
      devReloadScript() +
      '</head><body>' +
      body +
      '</body></html>'
    )
  }

  // indent the body two more levels so it nests cleanly under <body>
  const indentedBody = body
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n')

  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <link rel="icon" href="/base/logo.svg">',
    `    <title>${escapeText(title)}</title>`,
    ...tags.map(tag => `    ${tag}`),
    `    <link rel="stylesheet" href="${styleHref}">`,
    ...(importMap ? [`    ${importMap}`] : []),
    `    <script type="module" src="${scriptSrc}"></script>`,
    ...(DEV ? [`    ${devReloadScript()}`] : []),
    '  </head>',
    '  <body>',
    indentedBody,
    '  </body>',
    '</html>',
  ].join('\n')
}

// the namespace the dom docks as `<global:html>`
export const html = {
  serializeNode,
  documentShell,
  setTitle: stashTitle,
  setMeta: stashMeta,
  resetMeta,
  setProxy: stashProxy,
  takeProxy,
}
