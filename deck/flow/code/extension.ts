// The VS Code client for the Term language server. It launches the bundled server (code/main.ts, built to
// make/server.js beside this extension) as a child `node` process and speaks LSP to it over stdio. Syntax highlighting is
// provided separately by the TextMate grammar in text/tree.json; this client adds the semantic features the server
// implements (the list is the server's `initialize` capabilities, code/server.ts).

import * as path from 'node:path'
import { workspace } from 'vscode'
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
  const server = context.asAbsolutePath(path.join('make', 'server.js'))

  const serverOptions: ServerOptions = {
    run: { command: 'node', args: [server], transport: TransportKind.stdio },
    debug: {
      command: 'node',
      args: [server],
      transport: TransportKind.stdio,
    },
  }

  const clientOptions: LanguageClientOptions = {
    // an unsaved buffer is analyzed as well as a file: it compiles against the stdlib alone
    documentSelector: [
      { scheme: 'file', language: 'tree' },
      { scheme: 'untitled', language: 'tree' },
    ],
    synchronize: {
      // a `.tree` file created, changed or deleted outside the editor: the server re-reads the packages and
      // re-analyzes every open file that imported it. `role.tree` and `deck.tree` are `.tree` files too.
      fileEvents: workspace.createFileSystemWatcher('**/*.tree'),
    },
  }

  // the id is the prefix of the client's settings (`term.trace.server`). It was `seed` until the extension was
  // renamed `term-code` on 2026-10-02, which is a new Marketplace listing, so there was no installed configuration
  // left to keep by holding the old prefix.
  client = new LanguageClient(
    'term',
    'Term Language Server',
    serverOptions,
    clientOptions,
  )

  void client.start()
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop()
}
