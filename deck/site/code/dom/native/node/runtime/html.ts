// Runtime shim for server-side rendering: serialize the in-memory DOM tree (the node dom's `element` record) to an
// HTML string, and wrap a body in the document shell. Provided via <global:html>; the build prepends it next to the
// node dom impl that docks it (`dock load <global:html> name doc`, emitted as `const doc = html`, so the dom calls
// `doc.serializeNode` / `doc.documentShell`). The exported NAMESPACE is `html` (an object) -- distinct from the dom's
// own `serialize` / `page-shell` task names, so there is no duplicate-declaration collision when both are bundled.
// Walking the record in TS keeps the `<`, `>`, `"` HTML literals out of the `.tree` text-delimiter and gives correct
// escaping + void-element handling. A text node has an empty `tag`; an element has children (each a view wrapping its
// own record).

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

function serializeNode(node: { handle?: Element } | Element): string {
  const el = ('handle' in node && node.handle ? node.handle : node) as Element

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

function documentShell(body: string, title = 'ClueSurf'): string {
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

// the namespace the dom docks as `<global:html>`
export const html = { serializeNode, documentShell }
