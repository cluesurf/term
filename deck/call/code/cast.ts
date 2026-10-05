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
import { closeRun, failRun, field, openRun, report, reportProblems, showPath } from '@term/call/code/output'

// does the program's `boot` hand something back: a `return` with a value anywhere in its body, outside a nested task
// or closure.
// The cloudflare `host` answers the fetch handler, and `back host(route, port)` is how a boot passes it on
export function returnsHandler(program: readonly unknown[]): boolean {
  const boot = program.find(
    (node): node is { form: 'function'; name: string; body: unknown[] } =>
      typeof node === 'object' && node !== null && (node as { form?: string }).form === 'function' && (node as { name?: string }).name === 'boot',
  )

  const returns = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(returns)
    }

    if (typeof value !== 'object' || value === null) {
      return false
    }

    const node = value as { form?: string; value?: unknown }

    if (node.form === 'function' || node.form === 'closure') {
      return false
    }

    if (node.form === 'return' && node.value !== undefined) {
      return true
    }

    return Object.entries(node).some(([key, child]) => key !== 'span' && returns(child))
  }

  return boot !== undefined && returns(boot.body)
}

export async function callCast(input: {
  root: string
  entry?: string
  target?: string
}): Promise<void> {
  const target = input.target ?? 'cloudflare'
  const started = Date.now()

  openRun({ verb: 'cast', root: input.root, facts: [target] })

  if (target !== 'cloudflare') {
    report({ glyph: 'failed', kind: 'problem', subject: `There is no cast target named ${target}`, fields: [field('next', 'term cast --target cloudflare')] })
    closeRun({ verdict: 'Nothing cast', failure: 'usage' })

    return
  }

  try {
    const cwd = input.root
    const projectRoot = findProjectRoot(cwd)
    const entry = findEntry(cwd, input.entry)

    if (!entry || !existsSync(entry)) {
      report({
        glyph: 'failed',
        kind: 'problem',
        subject: entry ? 'The entry file does not exist' : 'There is no entry: none was given and deck.tree has no `boot <path>`',
        fields: entry ? [field('at', showPath(entry, input.root))] : [],
      })
      closeRun({ verdict: 'Nothing cast' })

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
      reportProblems(result.diagnostics.map(diagnostic => ({ diagnostic })), input.root)
      report({ glyph: 'failed', verb: 'build', subject: showPath(entry, input.root), duration: Date.now() - started, facts: ['cloudflare'] })
      closeRun({ verdict: 'Cast failed' })

      return
    }

    // the Worker's default export is what `boot` returns, so a `boot` that returns nothing casts to a Worker with no
    // `fetch`, and the first request is where that showed (guides: commands/cast, 2026-10-04). Refused here instead
    if (!returnsHandler(result.program)) {
      const boot = result.program.find(node => node.form === 'function' && node.name === 'boot')
      const line = boot?.span ? `:${boot.span.start.line + 1}` : ''
      report({
        glyph: 'failed',
        kind: 'problem',
        subject: '`boot` returns nothing, so the Worker would have no fetch handler',
        fields: [field('at', `${showPath(entry, input.root)}${line}`), field('next', 'end boot with `back host(route, port)`')],
      })
      report({ glyph: 'failed', verb: 'build', subject: showPath(entry, input.root), duration: Date.now() - started, facts: ['cloudflare'] })
      closeRun({ verdict: 'Nothing cast' })

      return
    }

    report({ glyph: 'done', verb: 'build', subject: showPath(entry, input.root), duration: Date.now() - started, facts: ['cloudflare'] })

    // 2. the browser client bundle + styles the SSR page loads (served from build/ via the Worker's
    // ASSETS binding). Same pipeline as the node SSR build, content hashes included: a Worker cannot read
    // `build/asset-manifest.json`, so the manifest is baked into the bundle below, as the import map is. They kept
    // their plain names until 2026-10-04, so a deploy could not replace a browser's cached copy (guides: commands/cast)
    buildStyles(appDir)
    await buildClientBundle({
      entry,
      appDir,
      projectRoot,
      installRoot,
      prod: true,
    })
    hashAssets(path.join(appDir, 'build'), true)
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
    const manifestFile = path.join(appDir, 'build', 'asset-manifest.json')
    const bakedManifest = existsSync(manifestFile)
      ? `globalThis.__SEED_ASSET_MANIFEST__ = ${readFileSync(manifestFile, 'utf8')};\n`
      : ''

    const source = `${bakedImportMap}${bakedManifest}${prelude}\n${result.typescript}`

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
      // a cast is a production build, and the Worker's `process.env` does not say so: the page shell read NODE_ENV as
      // unset and sent the development reload script, which polls `/base/__id` twice a second, and `?v=` links with an
      // empty build id (guides: commands/cast, 2026-10-04). Written into the bundle instead
      define: { 'process.env.NODE_ENV': '"production"' },
      // the browser bundle was minified and the Worker's was not
      minify: true,
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

    report({ glyph: 'done', verb: 'write', subject: showPath(path.join(workDir, 'app.mjs'), input.root) })
    report({ glyph: 'done', verb: 'write', subject: showPath(path.join(workDir, 'index.ts'), input.root) })
    closeRun({ verdict: 'Cast to a Cloudflare Worker', next: 'wrangler deploy' })
  } catch (err) {
    failRun(err, input.root)
  }
}
