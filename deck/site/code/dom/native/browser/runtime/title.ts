// Runtime shim for the browser `set-title` / `set-meta` dom tasks. Wraps the document-head mutations so the `.tree`
// side never expresses them directly. Provided to Seed via <global:title> (docked `name title`, so this object IS
// the binding); the dom calls `title.set` / `title.setMeta`. A namespace object (like resize / position / fontset)
// so the bundled client has no name collisions.
//
// Why a runtime shim instead of a `.tree` body: the browser impls mutate document-head state (`document.title =`,
// upsert a `<meta>`), and expressing that as a `.tree` member-assignment (`save page/title, ...`) hit a compiler
// drop. A native runtime keeps the browser DOM detail in one clean place and the dom task is a plain method call.

export const title = {
  // set the document title (per-route, from a route's `seed title` directive).
  set(text: string): void {
    if (typeof document !== 'undefined') {
      document.title = text
    }
  },

  // upsert a SEO meta tag live (per-route). og:* / article:* render as `property`, the rest as `name`, matching the
  // SSR document-shell. Reuses the existing element for a key if present, else creates + appends one.
  setMeta(name: string, content: string): void {
    if (typeof document === 'undefined') {
      return
    }
    const attribute =
      name.startsWith('og:') || name.startsWith('article:')
        ? 'property'
        : 'name'
    let element = document.head.querySelector(`meta[${attribute}="${name}"]`)
    if (!element) {
      element = document.createElement('meta')
      element.setAttribute(attribute, name)
      document.head.appendChild(element)
    }
    element.setAttribute('content', content)
  },

  // a resource route's proxy: on the client, nothing to stash (the server streams it); no-op.
  setProxy(): void {},
}

// The lowered route dispatcher calls `setTitle` / `setMeta` / `setProxy` at the top level (from a route's `seed title`
// / `seed description` / proxy directives), as BARE globals -- not through the dom's `set-title` task. On the server the
// node `html` runtime provides these free functions (draining into the SSR <head>); the browser needs the same free
// functions so the client bundle can hydrate. This prelude is concatenated in front of the compiled route code, so
// these top-level helpers are in scope for the route's bare calls, and the bundler retains them because the route
// references them. They delegate to the `title` namespace above so all browser DOM detail stays in one place, matching
// how the node `html` runtime exposes `setTitle` / `setMeta` / `setProxy`.
function setTitle(text: string): void {
  title.set(text)
}

function setMeta(name: string, content: string): void {
  title.setMeta(name, content)
}

function setProxy(): void {
  title.setProxy()
}
