// The VS Code client for the Seed language server. It launches the bundled server (deck/flow/code/main.ts, built to
// host/server.js next to this file) as a child `node` process and speaks LSP to it over stdio. Syntax highlighting is
// provided separately by the TextMate grammar in text/tree.json; this client adds the semantic features the server
// implements: diagnostics, hover, go-to-definition, references, rename, and document symbols.

import * as path from 'node:path'
import type { ExtensionContext } from 'vscode'
import {
  LanguageClient,
  TransportKind,
} from 'vscode-languageclient/node'
import type {
  LanguageClientOptions,
  ServerOptions,
} from 'vscode-languageclient/node'

let client: LanguageClient | undefined

export function activate(context: ExtensionContext): void {
  // the server is bundled next to this extension (see build.mjs), so it is fully self-contained -- no tsx, no
  // node_modules at runtime, the same binary whether run from source or a published .vsix
  const server = context.asAbsolutePath(path.join('host', 'server.js'))

  const serverOptions: ServerOptions = {
    run: { command: 'node', args: [server], transport: TransportKind.stdio },
    debug: {
      command: 'node',
      args: [server],
      transport: TransportKind.stdio,
    },
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'tree' }],
  }

  client = new LanguageClient(
    'seed',
    'Seed Language Server',
    serverOptions,
    clientOptions,
  )

  void client.start()
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop()
}
