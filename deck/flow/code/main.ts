// The node entry point for the Term language server. Editors launch it with `--stdio`; build.mjs bundles it into
// make/server.js, the server the VS Code extension starts. The server is Term: pump.tree's `serve-stdio` owns the real
// streams (one message at a time, a cancel read on arrival, nothing taking the process down), and the dispatcher and
// every request are the ports beside it (term-cli-in-term-0097 to 0104, live since term-cli-in-term-0117). The
// original pump is kept at tmp/retired/flow/main.ts.
import * as emitted from '@term/flow/code/pump'

// the emitted port may load as CommonJS (deck/flow/package.json has no `"type": "module"`), its exports under `default`
const port = ((emitted as { default?: unknown }).default ??
  emitted) as { serveStdio: () => void }

port.serveStdio()
