/**
 * The LSP client bootstrap for the Seed proof extension: start the Seed
 * flow language server (deck/flow) over stdio and connect VSCode to it.
 * This is the standard vscode-languageclient setup; it completes the
 * extension so the InfoView (infoview.ts) has a live client to make
 * `proof/state` and `proof/hammer` requests on.
 */

// resolves in the VSCode extension host, not in this sandbox.
// @ts-nocheck
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  LanguageClient,
  TransportKind,
  type ServerOptions,
  type LanguageClientOptions,
} from 'vscode-languageclient/node'

/** Start (and return) the Seed language client. */
export function startSeedLanguageClient(
  context: vscode.ExtensionContext,
): LanguageClient {
  // The Seed flow server entry. In a packaged extension this points at
  // the bundled server; in development at deck/flow's compiled main.
  const serverModule =
    process.env.SEED_FLOW_SERVER ??
    context.asAbsolutePath(path.join('server', 'flow', 'main.js'))

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'seed' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.tree'),
    },
  }

  const client = new LanguageClient(
    'seedProof',
    'Seed Proof',
    serverOptions,
    clientOptions,
  )

  client.start()
  context.subscriptions.push({ dispose: () => void client.stop() })
  return client
}
