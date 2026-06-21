// Runtime shim for server-side rendering: serialize the in-memory DOM tree (the node dom's `element` record) to an
// HTML string. Provided via <global:serialize>; the build prepends it next to the node dom impl that docks it. Walking
// the record in TS (rather than `.tree`) keeps the `<`, `>`, `"` HTML literals out of the `.tree` text-delimiter, and
// gives correct escaping + void-element handling. A text node has an empty `tag`; an element has children (each a view
// wrapping its own record). This is what turns a `route(host, path)` render into the HTML a server responds with.

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

// `node` is a `view` (a `{ handle }` wrapper) or an `element` record directly. Named `serializeNode` (not `serialize`)
// so it does not collide with the dom layer's own `serialize` task when both are bundled into one module.
export function serializeNode(node: { handle?: Element } | Element): string {
  const el = ('handle' in node && node.handle ? node.handle : node) as Element

  // a text node carries an empty tag
  if (!el.tag) {
    return escapeText(el.text ?? '')
  }

  const classAttr = el.classes?.length
    ? ` class="${escapeAttr(el.classes.join(' '))}"`
    : ''

  const attrs = (el.attributes ?? [])
    .map(attr => ` ${attr.name}="${escapeAttr(attr.value)}"`)
    .join('')

  const open = `<${el.tag}${classAttr}${attrs}>`

  if (VOID.has(el.tag)) {
    return open
  }

  const children = (el.children ?? [])
    .map(child => serializeNode(child))
    .join('')

  return `${open}${children}</${el.tag}>`
}

// wrap server-rendered body HTML in the document shell: charset/viewport, the title, the JIT stylesheet link, the
// SSR body, and the client module (which hydrates / takes over navigation). This is the full HTML a server responds
// with for SSR.
export function documentShell(body: string, title = 'ClueSurf'): string {
  return (
    '<!doctype html><html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeText(title)}</title>` +
    '<link rel="stylesheet" href="/base/look.css">' +
    '</head><body>' +
    body +
    '<script type="module" src="/base/boot.js"></script>' +
    '</body></html>'
  )
}
