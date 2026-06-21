// The dev HMR client (Tier 3). Served to the browser at `/@seed/client.mjs`. It opens an SSE connection, and on each
// message either full-reloads or hot-applies an update: re-import the changed module (cache-busted), then run the
// boundary's accept callback. The pure decision logic (`applyHmr`) is split out so it is unit-testable without a DOM.
// See note/research/repo/vite/04-websocket-protocol.md and 07-hmr-api.md.

// the messages the dev server pushes
export type HmrMessage =
  | { type: 'connected' }
  | { type: 'full-reload' }
  | {
      type: 'update'
      updates: {
        boundary: string
        accepted: string
        timestamp: number
      }[]
    }
  // a recompile error: show an overlay and keep the app running on its last-good code (no reload, state preserved)
  | { type: 'error'; errors: string[] }

// what the client needs from its environment (the browser provides these; a test provides fakes)
export interface HmrEnvironment {
  reload(): void
  // re-import a module URL cache-busted by timestamp, returning the fresh module namespace
  reimport(url: string, timestamp: number): Promise<unknown>
  // the accept callback a boundary module registered (via the hot API), if any
  acceptOf(boundary: string): ((module: unknown) => void) | undefined
  // the dispose hook a boundary module registered, run BEFORE the fresh module replaces it so it can snapshot its
  // state (signal values) and tear down its current view. Already bound to that boundary's persistent `data` bucket.
  disposeOf?(boundary: string): (() => void) | undefined
  // show / clear the compile-error overlay (the browser renders a DOM overlay; a test provides a fake)
  showError?(errors: string[]): void
  clearError?(): void
  log(message: string): void
}

// apply one HMR message. Pure control flow over the injected environment, so it is testable headlessly.
export async function applyHmr(
  message: HmrMessage,
  environment: HmrEnvironment,
): Promise<void> {
  if (message.type === 'connected') {
    environment.log('seed hmr connected')

    return
  }

  // a recompile error: keep the app running (no reload) and show the overlay; the next good update clears it
  if (message.type === 'error') {
    environment.showError?.(message.errors)

    return
  }

  if (message.type === 'full-reload') {
    environment.reload()

    return
  }

  // a successful update clears any error overlay left from a previous failed build
  environment.clearError?.()

  for (const update of message.updates) {
    // snapshot + tear down the OLD module before it is replaced, so its state survives into the fresh one
    const dispose = environment.disposeOf?.(update.boundary)

    if (dispose) {dispose()}

    const fresh = await environment.reimport(
      update.accepted,
      update.timestamp,
    )

    const accept = environment.acceptOf(update.boundary)

    if (accept) {accept(fresh)}
    else {environment.reload()} // no boundary callback: fall back to a reload
  }
}

// the browser client source. A small module that wires SSE to `applyHmr` with a real environment, and exposes a tiny
// hot registry (`window.__seedHot(url)`) that compiled boundary modules use to register an accept callback.
export function devClient(hmrUrl: string): string {
  return `// seed dev client (generated)
const registry = new Map()
window.__seedHot = (url) => {
  let entry = registry.get(url)
  if (!entry) { entry = { accept: undefined, data: {} }; registry.set(url, entry) }
  return {
    get data() { return entry.data },
    accept(callback) { entry.accept = callback },
    dispose(callback) { entry.dispose = callback },
    invalidate() { location.reload() },
  }
}
${applyHmr.toString()}
const environment = {
  reload: () => location.reload(),
  reimport: (url, t) => import(url.split('?')[0] + '?t=' + t),
  acceptOf: (boundary) => registry.get(boundary)?.accept,
  disposeOf: (boundary) => {
    const entry = registry.get(boundary)
    return entry && entry.dispose ? () => entry.dispose(entry.data) : undefined
  },
  log: (message) => console.log('[seed]', message),
}
const source = new EventSource(${JSON.stringify(hmrUrl)})
source.onmessage = (event) => applyHmr(JSON.parse(event.data), environment)
`
}
