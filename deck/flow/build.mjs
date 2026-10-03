// Bundle both halves of the VS Code extension with esbuild, into make/:
//   make/extension.js  -- the VS Code client, code/extension.ts (CJS, `vscode` left external; VS Code provides it)
//   make/server.js     -- the Term language server, code/main.ts, self-contained, with every `@term/*` import
//                         resolved through the Term package's tsconfig paths and inlined
//
// NOT host/. This folder is also the `@term/flow` deck, and host/ is where `term make` writes the deck's own output and
// what `term wash` deletes, so the extension bundles beside it rather than into it.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
// the Term package root holds the tsconfig with the @term/* path mappings: deck/flow -> ../..
const termRoot = path.resolve(here, '..', '..')
const watch = process.argv.includes('--watch')

// both bundles are CJS, where `import.meta` is empty. make/code/resolve.ts reads `import.meta.url` to walk up to the
// stdlib, and `fileURLToPath(undefined)` throws, so the bundle's own file url stands in for it
const shared = {
  bundle: true,
  platform: 'node',
  logLevel: 'info',
  define: { 'import.meta.url': '__bundleUrl' },
  banner: { js: "const __bundleUrl = require('node:url').pathToFileURL(__filename).href;" },
}

const extension = {
  ...shared,
  entryPoints: [path.join(here, 'code', 'extension.ts')],
  outfile: path.join(here, 'make', 'extension.js'),
  format: 'cjs',
  external: ['vscode'],
}

const server = {
  ...shared,
  entryPoints: [path.join(here, 'code', 'main.ts')],
  outfile: path.join(here, 'make', 'server.js'),
  format: 'cjs',
  tsconfig: path.join(termRoot, 'tsconfig.json'),
  // esbuild reaches the graph through one DYNAMIC import, call/code/make.ts `callMake` loading build-parallel.ts for
  // `term make --parallel`, which the server never calls (it imports only `projectResolver` and `findTreeFiles` from
  // that module). Bundled, esbuild's own `require.resolve("esbuild")` warns and would fail with no node_modules in
  // the .vsix; external, the `require` sits inside that import's lazy initializer and is never run.
  // test/server/wire.ts starts make/server.js itself and asks it to initialize.
  external: ['esbuild'],
}

if (watch) {
  const { context } = await import('esbuild')
  for (const config of [extension, server]) {
    const ctx = await context(config)
    await ctx.watch()
  }
  console.log('watching extension + server...')
} else {
  await Promise.all([build(extension), build(server)])
  console.log('built make/extension.js + make/server.js')
}
