/**
 * Extension entry point (package.json `main`). Delegates to the
 * InfoView module's activation, which starts the Seed language client
 * and registers the proof panel.
 */

// @ts-nocheck
export { activate } from './infoview'

export function deactivate(): void {
  // the client is disposed via context.subscriptions
}
