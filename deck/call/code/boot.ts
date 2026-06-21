import path from 'path'
import { fileURLToPath } from 'url'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  copyFileSync,
  rmSync,
} from 'fs'
import { build, buildSync, version as esbuildVersion } from 'esbuild'
import { compile } from '@cluesurf/make/code/compile/compile'
import {
  projectResolver,
  resolveTreeFile,
} from '@cluesurf/call/code/make'
import { nativePrelude } from '@cluesurf/make/code/compile/native'
import type { NativeEnv } from '@cluesurf/make/code/compile/native'
import { hashText } from '@cluesurf/make/code/compile/cache'
import {
  projectCache,
  compilerVersion,
} from '@cluesurf/call/code/cache-store'
import {
  pullRemoteCache,
  pushRemoteCache,
} from '@cluesurf/call/code/remote-cache'
import { toConstant } from '@cluesurf/make/code/compile/typescript'
import { parse } from '@cluesurf/make/code/parser/tree'
import type { GroupNode } from '@cluesurf/make/code/parser/tree'
import { runCommand } from '@cluesurf/call/code/make'
import {
  logStep,
  logGood,
  logFail,
  formatError,
  fade,
} from '@cluesurf/make/code/tint'

// the head name of a tree group (its first `name` node), and the group's first argument as text. The structured way to
// read a `.tree` file (mirrors the helpers in code/deck/install.ts).
function nodeHead(group: GroupNode): string | undefined {
  const first = group.nodes[0]

  return first?.kind === 'name'
    ? first.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join('')
    : undefined
}

function nodeValue(group: GroupNode): string {
  const arg = group.nodes[1]

  if (!arg) {return ''}

  if (arg.kind === 'text' || arg.kind === 'name')
    {return arg.parts
      .map(p => (p.kind === 'chunk' ? p.text : ''))
      .join('')}

  return ''
}

// bump to invalidate every boot cache at once (turborepo's `global_cache_key`). Change this on any boot-pipeline change
// that the per-build hash does not already capture (e.g. a new prelude assembly rule).
const BOOT_CACHE_EPOCH = '2'

// the directory (cwd or an ancestor) that holds the `link/` package links a build resolves through; falls back to cwd
export function findProjectRoot(start: string): string {
  let dir = start

  for (;;) {
    if (existsSync(path.join(dir, 'link'))) {return dir}

    const up = path.dirname(dir)

    if (up === dir) {return start}

    dir = up
  }
}

// resolve a bare entry path to its on-disk `.tree` file. A `boot ./hook/blog` directive names the module, not the file,
// so apply Seed's candidate order (`hook/blog.tree`, `hook/blog/base.tree`, ...). An already-exact path is taken as-is.
function resolveEntry(base: string): string | undefined {
  return resolveTreeFile(base) ?? (existsSync(base) ? base : undefined)
}

// the entry module's file: an explicit argument, or the `boot <path>` directive in the nearest `deck.tree` manifest
export function findEntry(
  cwd: string,
  entry: string | undefined,
): string | undefined {
  if (entry) {return resolveEntry(path.resolve(cwd, entry))}

  let dir = cwd

  for (;;) {
    const manifest = path.join(dir, 'deck.tree')

    if (existsSync(manifest)) {
      const text = readFileSync(manifest, 'utf8')
      const match = /(?:^|\n)\s*boot\s+(\S+)/.exec(text)

      if (match) {return resolveEntry(path.resolve(dir, match[1]!))}

      return undefined
    }

    const up = path.dirname(dir)

    if (up === dir) {return undefined}

    dir = up
  }
}

// the app package directory: the nearest ancestor (of the entry, else cwd) holding a `deck.tree` manifest
function findAppDir(start: string): string | undefined {
  let dir = start

  for (;;) {
    if (existsSync(path.join(dir, 'deck.tree'))) {return dir}

    const up = path.dirname(dir)

    if (up === dir) {return undefined}

    dir = up
  }
}

// load environment variables from `bind/host/base.tree` (the app's host config). It is a structured `.tree` file: a
// `host` group whose kebab children name values (`database-url <...>`). Each kebab key becomes a SCREAMING_SNAKE env
// var (`toConstant`). File values are defaults: anything already in the environment wins, so a shell override applies.
function loadHostEnv(appDir: string): string[] {
  const file = path.join(appDir, 'bind', 'host', 'base.tree')

  if (!existsSync(file)) {return []}

  const result = parse({ file, text: readFileSync(file, 'utf8') })

  if (!result.ok) {return []}

  const host = result.tree.nodes.find(g => nodeHead(g) === 'host')

  if (!host) {return []}

  const loaded: string[] = []

  for (const node of host.nodes.slice(1)) {
    if (node.kind !== 'group') {continue}

    const key = nodeHead(node)

    if (!key) {continue}

    const name = toConstant(key)

    if (process.env[name] !== undefined) {continue}

    process.env[name] = nodeValue(node)
    loaded.push(name)
  }

  return loaded
}

// build the browser CLIENT bundle for an SSR app: compile the SAME entry for the browser env (route lowering appends a
// top-level `boot("",0)` so it runs on load), prepend the browser native prelude, and esbuild it to `<app>/build/boot.js`.
// The SSR document shell references it as `/base/boot.js`; the static `/base/**` route serves it with a `text/javascript`
// content-type. This is what turns the server-rendered HTML interactive: on load the client takes over the body and the
// reactive runtime (signals / effects / events) keeps it live, with no second server round-trip. Cached on a content
// hash of the emitted source + toolchain, so an unchanged app reuses the prior bundle. Best-effort: a client-build
// failure logs and returns (SSR still serves without it) rather than failing the whole boot.
async function buildClientBundle(opts: {
  entry: string
  appDir: string
  projectRoot: string
  installRoot: string
  prod: boolean
}): Promise<void> {
  const { entry, appDir, projectRoot, installRoot, prod } = opts

  try {
    const resolve = projectResolver(appDir, 'browser', installRoot)
    const result = compile(
      { file: entry, text: readFileSync(entry, 'utf8') },
      { resolve, cache: projectCache(projectRoot), env: 'browser' },
    )

    if (!result.ok) {
      const first = result.diagnostics[0]
      logFail(
        `Client build failed: ${
          first ? `${first.name}: ${first.message}` : 'unknown error'
        } (server SSR still served)`,
      )
      return
    }

    const prelude = nativePrelude(
      result.program,
      'browser',
      p => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
      // only prepend shims actually referenced, so an unused dock (e.g. floating-ui `position`) stays out of the bundle
      result.typescript,
    )
    const source = `${prelude}\n${result.typescript}`

    // browser bundle: everything inlined (no `packages: external`), minified in prod for the smallest payload
    const bundleConfig = {
      bundle: true,
      format: 'esm' as const,
      platform: 'browser' as const,
      minify: prod,
    }

    const key = hashText(
      [
        BOOT_CACHE_EPOCH,
        compilerVersion(),
        'browser-client',
        `esbuild@${esbuildVersion}`,
        JSON.stringify(bundleConfig),
        source,
      ].join('\n'),
    )

    const buildDir = path.join(appDir, 'build')
    mkdirSync(buildDir, { recursive: true })
    const outFile = path.join(buildDir, 'boot.js')
    const mapFile = path.join(buildDir, 'import-map.json')
    const stampFile = path.join(buildDir, '.boot.js.key')

    // the stamp is the content hash of the last-built bundle: if it matches, build/boot.js is already current
    if (
      existsSync(outFile) &&
      existsSync(stampFile) &&
      readFileSync(stampFile, 'utf8') === key
    ) {
      logGood(`Cached client bundle (build/boot.js)`)
      return
    }

    // bundle once into the shared cache dir (keyed by content), then copy into the app's build output
    const cacheOut = path.join(projectRoot, '.seed', 'client', key)
    const cacheFile = path.join(cacheOut, 'boot.js')
    const cacheMap = path.join(cacheOut, 'import-map.json')

    if (!existsSync(cacheFile)) {
      mkdirSync(cacheOut, { recursive: true })
      const srcFile = path.join(cacheOut, 'boot.ts')
      writeFileSync(srcFile, source)

      // externalize every bare (npm) specifier and load it from a CDN via an import map, so the app needs no local
      // install of its browser deps (floating-ui, etc.). The app's own code is all relative / inlined, so the only bare
      // specifiers are genuine third-party packages -- exactly the minimal native edge. Collected here, mapped below.
      const externals: string[] = []
      await build({
        entryPoints: [srcFile],
        outfile: cacheFile,
        ...bundleConfig,
        plugins: [
          {
            name: 'externalize-bare-specifiers',
            setup(b) {
              b.onResolve({ filter: /^[^./]/ }, args => {
                if (args.path.startsWith('node:')) {
                  return { path: args.path, external: true }
                }

                if (!externals.includes(args.path)) {
                  externals.push(args.path)
                }

                return { path: args.path, external: true }
              })
            },
          },
        ],
      })

      // map each external to an esm.sh CDN module (a web-standard import map; no bundler or install needed at runtime)
      const importMap: { imports: Record<string, string> } = { imports: {} }

      for (const dep of externals) {
        importMap.imports[dep] = `https://esm.sh/${dep}`
      }

      writeFileSync(cacheMap, JSON.stringify(importMap, null, 2))
    }

    copyFileSync(cacheFile, outFile)

    if (existsSync(cacheMap)) {
      copyFileSync(cacheMap, mapFile)
    }

    writeFileSync(stampFile, key)
    logGood(`Built client bundle -> build/boot.js (${key.slice(0, 8)})`)
  } catch (err) {
    logFail(`Client build error: ${formatError(err)} (server SSR still served)`)
  }
}

// the tone alphabet (hex nibble -> letter), the TS twin of base/code/tone.tree. Ports `belt/code/tool/tone.ts`: each
// hex digit maps to a consonant, grouped 4-4 with dashes. A content hash -> a short pronounceable cache-bust suffix.
const TONE = 'mndbtkhsfvzxcwlr'

function toneEncode(hex: string): string {
  const letters = [...hex]
    .map(ch => TONE[parseInt(ch, 16)] ?? '')
    .join('')
  const groups: string[] = []

  for (let i = 0; i < letters.length; i += 4) {
    groups.push(letters.slice(i, i + 4))
  }

  return groups.join('-')
}

// PRODUCTION asset hashing + manifest. Content-hash each cache-bust-critical build output (the stylesheet + the client
// bundle), tone-encode the hash into a short suffix, write a hashed copy (`style/look-mndb-tksh.css`), and record the
// logical -> hashed mapping in `build/asset-manifest.json`. The SSR document shell reads that manifest to emit the
// hashed URLs, so a deploy busts every cache automatically (the name changes with the bytes). DEV writes no manifest
// and uses the stable names, so a refresh always shows the latest. Idempotent: a prior run's hashed copies + manifest
// are removed first, so re-runs (and a dev run after a prod run) start from a clean canonical set.
function hashAssets(buildDir: string, prod: boolean): void {
  const manifestFile = path.join(buildDir, 'asset-manifest.json')

  // clear any prior manifest and the hashed files it named, so stale hashed copies never accumulate or get re-hashed
  let prior: Record<string, string> = {}

  try {
    prior = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<
      string,
      string
    >
  } catch {
    // no prior manifest
  }

  for (const hashed of Object.values(prior)) {
    try {
      const file = path.join(buildDir, hashed)

      if (existsSync(file)) {rmSync(file)}
    } catch {
      // a missing / unremovable stale file is not fatal
    }
  }

  try {
    if (existsSync(manifestFile)) {rmSync(manifestFile)}
  } catch {
    // ignore
  }

  // dev: stable names, no manifest (the shell resolves every asset to itself)
  if (!prod) {return}

  const sources = ['style/look.css', 'boot.js']
  const map: Record<string, string> = {}

  for (const logical of sources) {
    const file = path.join(buildDir, logical)

    if (!existsSync(file)) {continue}

    const tone = toneEncode(hashText(readFileSync(file, 'utf8')).slice(0, 8))
    const dot = logical.lastIndexOf('.')
    const hashed =
      dot >= 0
        ? `${logical.slice(0, dot)}-${tone}${logical.slice(dot)}`
        : `${logical}-${tone}`

    copyFileSync(file, path.join(buildDir, hashed))
    map[logical] = hashed
  }

  writeFileSync(manifestFile, JSON.stringify(map, null, 2))
  logGood(
    `Hashed ${Object.keys(map).length} assets -> build/asset-manifest.json`,
  )
}

export async function callBoot(input: {
  root: string
  entry?: string
  env?: NativeEnv
  port?: number
  remote?: string
  remoteToken?: string
}): Promise<void> {
  logStep('Booting app...')

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
    }

    const env: NativeEnv = input.env ?? 'node'

    // load the app's host env config (`bind/host/base.tree`), so a bare `seed boot` needs no inline env vars
    const appDir = findAppDir(entry) ?? findAppDir(cwd)
    const loadedEnv = appDir ? loadHostEnv(appDir) : []

    if (loadedEnv.length)
      {console.log(
        fade(`  env: ${loadedEnv.join(', ')} (bind/host/base.tree)`),
      )}

    // warm the local cache from a remote (Tier 5) before compiling, so a cold machine / CI reuses shared artifacts
    const cacheDir = path.join(projectRoot, '.seed', 'cache')

    if (input.remote) {
      try {
        const pulled = await pullRemoteCache(
          cacheDir,
          input.remote,
          input.remoteToken,
        )

        if (pulled)
          {console.log(
            fade(
              `  pulled ${pulled} cache artifacts from ${input.remote}`,
            ),
          )}
      } catch {
        // a remote-cache failure must never fail the build
      }
    }

    // the seed CLI's own install dir (the nearest `link/` ancestor of this module), used as a fallback link root so an
    // app that has not run `seed link` itself still resolves `@cluesurf/*` through the install's stdlib links
    const installRoot = findProjectRoot(
      path.dirname(fileURLToPath(import.meta.url)),
    )

    // compile the entry (and everything it loads) through the package manager, targeting the chosen env. A persistent
    // cache (`.seed/cache`) makes a cold re-boot reuse the prior parse + mill + compile (Tier 1).
    // resolve modules against the APP dir (the entry's package root, holding `deck.tree`), not the link/cache
    // `projectRoot`, so the app's own `@scope/...` and relative imports resolve correctly.
    const resolve = projectResolver(appDir ?? projectRoot, env, installRoot)
    const result = compile(
      { file: entry, text: readFileSync(entry, 'utf8') },
      { resolve, cache: projectCache(projectRoot), env },
    )

    if (!result.ok) {
      const first = result.diagnostics[0]
      logFail(
        `Compile failed: ${
          first ? `${first.name}: ${first.message}` : 'unknown error'
        }`,
      )
      process.exit(1)
    }

    // push freshly-built artifacts to the remote (Tier 5), so the next machine / CI reuses them
    if (input.remote) {
      try {
        const pushed = await pushRemoteCache(
          cacheDir,
          input.remote,
          input.remoteToken,
        )

        if (pushed)
          {console.log(
            fade(
              `  pushed ${pushed} cache artifacts to ${input.remote}`,
            ),
          )}
      } catch {
        // a remote-cache failure must never fail the build
      }
    }

    // for an SSR server (the node host), also build the browser CLIENT bundle the rendered page loads (`/base/boot.js`),
    // so the server-rendered HTML becomes interactive. The app must have a deck.tree root (appDir) to hold `build/`.
    if (env === 'node' && appDir) {
      const prod = process.env.NODE_ENV === 'production'
      await buildClientBundle({ entry, appDir, projectRoot, installRoot, prod })
      // content-hash the cache-bust-critical assets (stylesheet + client bundle) and write the manifest the shell reads
      hashAssets(path.join(appDir, 'build'), prod)
    }

    // auto-prepend the native runtime shims this program docks (`<global:X>` -> its `runtime/X` sibling), so the
    // platform driver wrappers are present without userland ever importing them. This is the prelude the build owns.
    const prelude = nativePrelude(result.program, env, p =>
      existsSync(p) ? readFileSync(p, 'utf8') : undefined,
    )

    const source = `${prelude}\n${result.typescript}`

    // the bundle config (kept in one place so the cache key sees exactly what the build uses)
    const bundleConfig = {
      bundle: true,
      format: 'esm' as const,
      platform: env === 'browser' ? ('browser' as const) : ('node' as const),
      packages: 'external' as const,
    }

    // incremental cache in `.seed/boot/<hash>`. The key folds in everything that can change the output: the emitted
    // source (which already reflects the compiler's behavior for this input), the target env, the bundler version, the
    // bundler config, and a manual epoch. So a stale hit cannot survive a toolchain or config change. See
    // note/research/repo/turborepo/07-lessons-for-seed.md.
    const key = hashText(
      [
        BOOT_CACHE_EPOCH,
        // the running compiler's content fingerprint: any change to the compiler invalidates the bundle, with no manual
        // epoch bump. The single most important guard against a stale hit.
        compilerVersion(),
        env,
        `esbuild@${esbuildVersion}`,
        JSON.stringify(bundleConfig),
        source,
      ].join('\n'),
    )

    const out = path.join(projectRoot, '.seed', 'boot', key)
    const bundle = path.join(out, 'app.mjs')

    if (existsSync(bundle)) {
      logGood(
        `Cached ${path.relative(cwd, entry)} (.seed/boot/${key.slice(0, 8)})`,
      )
    } else {
      mkdirSync(out, { recursive: true })
      writeFileSync(path.join(out, 'app.ts'), source)
      buildSync({
        entryPoints: [path.join(out, 'app.ts')],
        outfile: bundle,
        ...bundleConfig,
      })
      logGood(
        `Built ${path.relative(cwd, entry)} -> .seed/boot/${key.slice(0, 8)}`,
      )
    }

    // the bundle keeps node packages (pg, hono, ...) external, so they are imported at runtime. ESM resolves bare
    // specifiers from the importing file's location, not cwd or NODE_PATH, so link the CLI install's node_modules next
    // to the bundle. An app with its own node_modules (a published install) keeps using its own.
    const bundleModules = path.join(out, 'node_modules')
    const installModules = path.join(installRoot, 'node_modules')

    if (!existsSync(bundleModules) && existsSync(installModules)) {
      try {
        symlinkSync(installModules, bundleModules, 'dir')
      } catch {
        // a pre-existing link or a race is fine
      }
    }

    const port = input.port ?? 8787
    writeFileSync(
      path.join(out, 'run.mjs'),
      [
        `import * as app from './app.mjs'`,
        `const boot = app.boot ?? app.start ?? app.main`,
        `if (!boot) { console.error('entry has no boot/start/main task'); process.exit(1) }`,
        `const url = process.env.DATABASE_URL ?? ''`,
        `const port = Number(process.env.PORT ?? ${port})`,
        `await boot(url, port)`,
        '',
      ].join('\n'),
    )

    logGood(`Serving on http://localhost:${port}`)
    console.log(fade(`  press ctrl-c to stop`))
    // run the server from the APP dir (where the `deck.tree` + `build/` live), so the app resolves its own assets
    // (`build/...` static files) relative to its own root rather than the link/cache `projectRoot`.
    await runCommand({
      cmd: 'node',
      args: [path.join(out, 'run.mjs')],
      cwd: appDir ?? projectRoot,
      shell: false,
    })
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
