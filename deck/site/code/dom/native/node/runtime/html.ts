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

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
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
    manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  } catch {
    manifest = null
  }

  return manifest
}

// resolve a logical asset path to its public `/base/...` URL, applying the content-hashed name in production
function assetUrl(logical: string): string {
  const map = assetMap()
  const resolved = (map && map[logical]) || logical

  return `/base/${resolved}`
}

function elementOf(node: { handle?: Element } | Element): Element {
  return ('handle' in node && node.handle ? node.handle : node) as Element
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

// the document shell links the stylesheet as an EXTERNAL file and loads the client bundle as a module script (both
// served by the host's static `/base/` route, cacheable, not re-sent per page). The script makes the server-rendered
// page interactive: on load it takes over the body and the reactive runtime keeps it live. Prod uses content-hashed
// names (via the asset manifest); dev uses the stable paths. Both resolved through `assetUrl`.
function documentShell(body: string, title = 'ClueSurf'): string {
  const styleHref = assetUrl('style/look.css')
  const scriptSrc = assetUrl('boot.js')

  if (!PRETTY) {
    return (
      '<!doctype html><html lang="en"><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>${escapeText(title)}</title>` +
      `<link rel="stylesheet" href="${styleHref}">` +
      `<script type="module" src="${scriptSrc}"></script>` +
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
    `    <title>${escapeText(title)}</title>`,
    `    <link rel="stylesheet" href="${styleHref}">`,
    `    <script type="module" src="${scriptSrc}"></script>`,
    '  </head>',
    '  <body>',
    indentedBody,
    '  </body>',
    '</html>',
  ].join('\n')
}

// the namespace the dom docks as `<global:html>`
export const html = { serializeNode, documentShell }

