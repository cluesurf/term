// `term cast --target cloudflare`: build a Term `.tree` SSR app into a deployable Cloudflare Worker.
//
// A `.tree` SSR app (`boot ./site/boot`, the `hook` routing DSL, `@term/site`) runs three ways from
// ONE source: the browser (client bundle), a node HTTP server (`term feed` / `term boot`), and now a
// Cloudflare Worker. The env-abstracted `host` picks the impl (browser mounts, node listens, the
// Worker exports a fetch handler); this command drives the Worker build:
//
//   1. compile the SSR entry for the `cloudflare` env (the native-env mechanism selects the Worker
//      transport + host; the router + DOM + render are the same pure code as node),
//   2. build the browser client bundle + styles into `build/` (served by the Worker's ASSETS binding,
//      exactly the node SSR client path),
//   3. bundle the compiled app to `work/app.mjs` (ESM; node built-ins stay external for the Worker's
//      `nodejs_compat`),
//   4. emit `work/index.ts` -- the Worker entry that runs the app and re-exports the fetch handler its
//      `boot` returns as `export default`.
//
// `wrangler deploy` then bundles `work/index.ts` (its `main`) and uploads it, with `build/` as the
// static-assets binding. The Cloudflare zone + apex Custom Domain live in the infra repo (land/form).

import path from 'path'
import { fileURLToPath } from 'url'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  cpSync,
} from 'fs'
import { buildSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { printDiagnostics } from '@term/call/code/report'
import { nativePrelude } from '@term/make/code/compile/native'
import {
  findProjectRoot,
  findEntry,
  findAppDir,
  buildClientBundle,
  buildStyles,
  hashAssets,
  writeBuildId,
} from '@term/call/code/boot'
import { projectCache } from '@term/call/code/cache-store'
import {
  logStep,
  logGood,
  logFail,
  formatError,
} from '@term/make/code/tint'

export async function callCast(input: {
  root: string
  entry?: string
  target?: string
}): Promise<void> {
  const target = input.target ?? 'cloudflare'

  if (target !== 'cloudflare') {
    logFail(
      `Unknown cast target: ${target} (only \`cloudflare\` is supported)`,
    )
    process.exit(1)
  }

  logStep(`Casting app to a Cloudflare Worker...`)

  try {
    const cwd = input.root
    const projectRoot = findProjectRoot(cwd)
    const entry = findEntry(cwd, input.entry)

    if (!entry || !existsSync(entry)) {
      logFail(
        entry
          ? `Entry not found: ${entry}`
          : 'No entry given and no `boot <path>` in deck.tree',
      )
      process.exit(1)

      return
    }

    const appDir = findAppDir(entry) ?? findAppDir(cwd) ?? projectRoot
    const installRoot = findProjectRoot(
      path.dirname(fileURLToPath(import.meta.url)),
    )

    // a cast is always a production build (a Worker deploy). Set NODE_ENV so the client bundle is
    // minified and the style build takes its production path.
    process.env.NODE_ENV = 'production'

    const env = 'cloudflare'
    const resolve = projectResolver(appDir, env, installRoot)
    const cache = projectCache(projectRoot)

    // 1. compile the SSR entry for the cloudflare env
    const result = compile(
      { file: entry, text: readFileSync(entry, 'utf8') },
      { resolve, cache, env },
    )

    if (!result.ok) {
      printDiagnostics(result.diagnostics)
      logFail(
        `Compile failed: ${result.diagnostics.length} error${
          result.diagnostics.length === 1 ? '' : 's'
        }`,
      )
      process.exit(1)

      return
    }

    // 2. the browser client bundle + styles the SSR page loads (served from build/ via the Worker's
    // ASSETS binding). Same pipeline as the node SSR build. Assets keep their logical `/base/...`
    // names (no content-hash manifest): on a Worker the shell cannot read the manifest from disk, so
    // the transport serves the unhashed names the shell emits.
    buildStyles(appDir)
    await buildClientBundle({
      entry,
      appDir,
      projectRoot,
      installRoot,
      prod: true,
    })
    hashAssets(path.join(appDir, 'build'), false)
    writeBuildId(appDir)

    // static passthrough: copy everything under the app's `asset/` into `build/` verbatim (fonts,
    // logos, favicons, ...). These ship as-is and are served from `/base/...` by the ASSETS binding,
    // so `asset/text/CrowMark-Regular.otf` becomes `/base/text/CrowMark-Regular.otf`.
    const assetDir = path.join(appDir, 'asset')

    if (existsSync(assetDir)) {
      cpSync(assetDir, path.join(appDir, 'build'), { recursive: true })
    }

    // 3. bundle the compiled app to work/app.mjs. Node built-ins stay external (platform node), so the
    // Worker's `nodejs_compat` provides them at runtime; everything else is inlined.
    const prelude = nativePrelude(result.program, env, p =>
      existsSync(p) ? readFileSync(p, 'utf8') : undefined,
    )

    // bake the client bundle's import map into the SSR shell. The document shell (`<global:html>`) inlines an
    // `<script type="importmap">` before the module script so the browser can resolve the client bundle's externalized
    // npm deps (floating-ui, ...) from the CDN. On node SSR the shell reads `build/import-map.json` off disk, but a
    // Worker has no filesystem, so that read throws and no import map is emitted -- leaving the client unable to load.
    // Injecting the parsed map as a `globalThis` constant here makes the shell emit it with no runtime file read.
    const importMapFile = path.join(appDir, 'build', 'import-map.json')
    const importMapJson = existsSync(importMapFile)
      ? readFileSync(importMapFile, 'utf8')
      : '{"imports":{}}'
    const bakedImportMap = `globalThis.__SEED_IMPORT_MAP__ = ${importMapJson};\n`

    const source = `${bakedImportMap}${prelude}\n${result.typescript}`

    const workDir = path.join(appDir, 'work')
    mkdirSync(workDir, { recursive: true })

    const appTs = path.join(workDir, 'app.ts')
    writeFileSync(appTs, source)

    buildSync({
      entryPoints: [appTs],
      outfile: path.join(workDir, 'app.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
    })

    // 4. emit the Worker entry: run the app (its `boot` builds the routes and returns the fetch
    // handler) and re-export that handler as the Worker's default export.
    writeFileSync(
      path.join(workDir, 'index.ts'),
      [
        `// GENERATED by \`term cast --target cloudflare\`. The Cloudflare Worker entry: it runs the`,
        `// compiled Term SSR app (./app.mjs) and re-exports the Web fetch handler its \`boot\` returns`,
        `// as the Worker's default export. Static assets are served from build/ via the ASSETS`,
        `// binding (see wrangler.toml). Do not edit by hand -- re-run \`term cast\` to regenerate.`,
        `import * as app from './app.mjs'`,
        ``,
        `const worker = await app.boot('', 0)`,
        ``,
        `export default worker`,
        ``,
      ].join('\n'),
    )

    logGood(
      `Cast -> work/index.ts + work/app.mjs (deploy: \`wrangler deploy\`)`,
    )
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
