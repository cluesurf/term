// Bundle both halves of the extension with esbuild:
//   host/extension.js  -- the VS Code client (CJS, `vscode` left external; VS Code provides it at runtime)
//   host/server.js     -- the Seed language server (deck/flow/code/main.ts), self-contained, with every `@cluesurf/*`
//                         import resolved through the seed package's tsconfig paths and inlined
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
// the seed package root holds the tsconfig with the @cluesurf/* path mappings: deck/flow/editor/vscode -> ../../../..
const seedRoot = path.resolve(here, '..', '..', '..', '..')
const watch = process.argv.includes('--watch')

const shared = { bundle: true, platform: 'node', logLevel: 'info' }

const extension = {
  ...shared,
  entryPoints: [path.join(here, 'code', 'extension.ts')],
  outfile: path.join(here, 'host', 'extension.js'),
  format: 'cjs',
  external: ['vscode'],
}

const server = {
  ...shared,
  entryPoints: [path.join(seedRoot, 'deck', 'flow', 'code', 'main.ts')],
  outfile: path.join(here, 'host', 'server.js'),
  format: 'cjs',
  tsconfig: path.join(seedRoot, 'tsconfig.json'),
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
  console.log('built host/extension.js + host/server.js')
}
