// Runtime shim for the routing boot glue: the browser bits the `.tree` app boot needs that are not single DOM-node ops
// -- the current path, the document title, the mount body, and a navigation listener. Provided via <global:route>; the
// build prepends it next to the browser dom impl that docks it. Keeps location / history / title plumbing out of `.tree`.
// `listenPop` wires SPA navigation: it fires the handler on back/forward (popstate) AND intercepts same-origin link
// clicks (pushState + handler), so `<a href="/...">` navigates without a full reload.

export function pagePath(): string {
  return window.location.pathname
}

export function setTitle(title: string): void {
  document.title = title
}

export function pageBody(): HTMLElement {
  return document.body
}

export function listenPop(handler: () => void): void {
  window.addEventListener('popstate', handler)

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null
    const anchor = target?.closest?.('a')

    if (!anchor) {
      return
    }

    const href = anchor.getAttribute('href')

    if (
      href &&
      href.startsWith('/') &&
      anchor.host === window.location.host
    ) {
      event.preventDefault()
      window.history.pushState({}, '', href)
      handler()
    }
  })
}
