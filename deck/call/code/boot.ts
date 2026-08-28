import path from 'path'
import net from 'net'
import { fileURLToPath } from 'url'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  copyFileSync,
  rmSync,
  readdirSync,
  watch,
} from 'fs'
import { build, buildSync, version as esbuildVersion } from 'esbuild'
import { spawn } from 'node:child_process'
import { commandRoutes } from '@term/call/code/hook-dispatch'
import type { ChildProcess } from 'node:child_process'
import { compile } from '@term/make/code/compile/compile'
import {
  projectResolver,
  resolveTreeFile,
  watchTreeFiles,
} from '@term/call/code/make'
import { printDiagnostics } from '@term/call/code/report'
import { nativePrelude } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import { hashText } from '@term/make/code/compile/cache'
import {
  projectCache,
  compilerVersion,
} from '@term/call/code/cache-store'
import {
  pullRemoteCache,
  pushRemoteCache,
} from '@term/call/code/remote-cache'
import { toConstant } from '@term/make/code/compile/typescript'
import { parse } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/tree'
import {
  logStep,
  logGood,
  logFail,
  formatError,
  fade,
} from '@term/make/code/tint'

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

  if (!arg) {
    return ''
  }

  if (arg.kind === 'text' || arg.kind === 'name') {
    return arg.parts
      .map(p => (p.kind === 'chunk' ? p.text : ''))
      .join('')
  }

  return ''
}

// bump to invalidate every boot cache at once (turborepo's `global_cache_key`). Change this on any boot-pipeline change
// that the per-build hash does not already capture (e.g. a new prelude assembly rule).
const BOOT_CACHE_EPOCH = '8'

// the default port range: `seed boot` scans 2400..2499 for the first free port, so an app always starts on a good port
// no matter where (or how many) you boot, with no manual `--port`.
const BASE_PORT = 2400
const MAX_PORT = 2499

// true if a TCP port is free to bind. The test MUST bind the same way the real server does (all interfaces, dual-stack)
// or a stale IPv6-bound server (`:::2400`) would look free to an IPv4-only probe and the child would then EADDRINUSE.
function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true))
      })
      // no host arg -> bind all interfaces (matches @hono/node-server's default), so the probe sees the real conflict
      .listen(port)
  })
}

// the first free port in 2400..2499 (incrementing by 1). Throws if the whole range is taken (loud, not a silent reuse).
async function findFreePort(start: number): Promise<number> {
  for (let port = start; port <= MAX_PORT; port++) {
    if (await portIsFree(port)) {
      return port
    }
  }

  throw new Error(
    `no free port in ${start}..${MAX_PORT} (stop apps with \`seed halt\`)`,
  )
}

// the directory (cwd or an ancestor) that holds the `link/` package links a build resolves through; falls back to cwd
export function findProjectRoot(start: string): string {
  let dir = start

  for (;;) {
    if (existsSync(path.join(dir, 'link'))) {
      return dir
    }

    const up = path.dirname(dir)

    if (up === dir) {
      return start
    }

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
  if (entry) {
    return resolveEntry(path.resolve(cwd, entry))
  }

  let dir = cwd

  for (;;) {
    const manifest = path.join(dir, 'deck.tree')

    if (existsSync(manifest)) {
      const text = readFileSync(manifest, 'utf8')
      const match = /(?:^|\n)\s*boot\s+(\S+)/.exec(text)

      if (match) {
        return resolveEntry(path.resolve(dir, match[1]!))
      }

      return undefined
    }

    const up = path.dirname(dir)

    if (up === dir) {
      return undefined
    }

    dir = up
  }
}

// the app package directory: the nearest ancestor (of the entry, else cwd) holding a `deck.tree` manifest
export function findAppDir(start: string): string | undefined {
  let dir = start

  for (;;) {
    if (existsSync(path.join(dir, 'deck.tree'))) {
      return dir
    }

    const up = path.dirname(dir)

    if (up === dir) {
      return undefined
    }

    dir = up
  }
}

// load environment variables from `bind/host/base.tree` (the app's host config). It is a structured `.tree` file: a
// `host` group whose kebab children name values (`database-url <...>`). Each kebab key becomes a SCREAMING_SNAKE env
// var (`toConstant`). File values are defaults: anything already in the environment wins, so a shell override applies.
function loadHostEnv(appDir: string): string[] {
  const file = path.join(appDir, 'bind', 'host', 'base.tree')

  if (!existsSync(file)) {
    return []
  }

  const result = parse({ file, text: readFileSync(file, 'utf8') })

  if (!result.ok) {
    return []
  }

  const host = result.tree.nodes.find(g => nodeHead(g) === 'host')

  if (!host) {
    return []
  }

  const loaded: string[] = []

  for (const node of host.nodes.slice(1)) {
    if (node.kind !== 'group') {
      continue
    }

    const key = nodeHead(node)

    if (!key) {
      continue
    }

    const name = toConstant(key)

    if (process.env[name] !== undefined) {
      continue
    }

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
export async function buildClientBundle(opts: {
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
      printDiagnostics(result.diagnostics)
      logFail(
        `Client build failed: ${result.diagnostics.length} error${
          result.diagnostics.length === 1 ? '' : 's'
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
    const cacheOut = path.join(projectRoot, '.base/term', 'client', key)
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
      const importMap: { imports: Record<string, string> } = {
        imports: {},
      }

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
    logFail(
      `Client build error: ${formatError(err)} (server SSR still served)`,
    )
  }
}

// the tone alphabet (the TS twin of base/code/tone.tree, alphabet from belt/code/tool/tone.ts). Each input char maps to
// one of 16 consonants by its char code, and the result is grouped 4-by-4 with dashes -- turning a content hash into a
// short pronounceable cache-bust suffix (`mndb-tksh`).
const TONE = 'mndbtkhsfvzxcwlr'

function toneEncode(text: string): string {
  const letters = [...text]
    .map(ch => TONE[ch.charCodeAt(0) % 16])
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
export function hashAssets(buildDir: string, prod: boolean): void {
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

      if (existsSync(file)) {
        rmSync(file)
      }
    } catch {
      // a missing / unremovable stale file is not fatal
    }
  }

  try {
    if (existsSync(manifestFile)) {
      rmSync(manifestFile)
    }
  } catch {
    // ignore
  }

  // dev: stable names, no manifest (the shell resolves every asset to itself)
  if (!prod) {
    return
  }

  const sources = ['style/look.css', 'boot.js']
  const map: Record<string, string> = {}

  for (const logical of sources) {
    const file = path.join(buildDir, logical)

    if (!existsSync(file)) {
      continue
    }

    const tone = toneEncode(
      hashText(readFileSync(file, 'utf8')).slice(0, 8),
    )

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

// the dev live-reload build id: the client polls `/base/__id` and reloads when it changes. Bumped on boot and on every
// hot style rebuild, so an edit shows in the browser with no manual refresh. A timestamp is enough (monotonic + unique).
export function writeBuildId(appDir: string): void {
  try {
    const buildDir = path.join(appDir, 'build')
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(path.join(buildDir, '__id'), String(Date.now()))
  } catch {
    // a reload-id write failure must never fail the build
  }
}

// recompile every look stylesheet (`site/style/*.tree`) to `build/style/*.css`, then bump the reload id. Look files are
// self-contained (only `face` / `tone` / `base` statements), so they compile with no resolver. This is what makes
// `seed boot` self-sufficient (no separate make step for CSS) and what the dev watcher calls on each style edit.
export function buildStyles(appDir: string): void {
  const styleDir = path.join(appDir, 'site', 'style')

  if (!existsSync(styleDir)) {
    return
  }

  const outDir = path.join(appDir, 'build', 'style')
  mkdirSync(outDir, { recursive: true })

  for (const name of readdirSync(styleDir)) {
    if (!name.endsWith('.tree')) {
      continue
    }

    const file = path.join(styleDir, name)

    try {
      const result = compile({ file, text: readFileSync(file, 'utf8') })

      if (result.ok && result.css !== undefined) {
        writeFileSync(
          path.join(outDir, name.replace(/\.tree$/, '.css')),
          result.css,
        )
      }
    } catch {
      // a single bad stylesheet must not crash the dev loop
    }
  }
}

// dev hot-reload for styles: watch `site/style` and recompile + bump the reload id on each edit, debounced. The server
// serves `build/style/*.css` + `build/__id` fresh per request, so the browser's poll picks up the new id and reloads
// with the new CSS -- no manual refresh, no server restart. Returns a stop function.
function watchStyles(appDir: string): () => void {
  const styleDir = path.join(appDir, 'site', 'style')

  if (!existsSync(styleDir)) {
    return () => {}
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  const watcher = watch(styleDir, { recursive: true }, () => {
    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      buildStyles(appDir)
      writeBuildId(appDir)
      logGood('Styles rebuilt (hot reload)')
    }, 60)
  })

  return () => {
    if (timer) {
      clearTimeout(timer)
    }

    watcher.close()
  }
}

export async function callBoot(input: {
  root: string
  entry?: string
  env?: NativeEnv
  port?: number
  remote?: string
  remoteToken?: string
  /** arguments forwarded to a command-line program (an entry whose
   * top level declares `hook` commands). Ignored for servers. */
  args?: string[]
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

    if (loadedEnv.length) {
      console.log(
        fade(`  env: ${loadedEnv.join(', ')} (bind/host/base.tree)`),
      )
    }

    // warm the local cache from a remote (Tier 5) before compiling, so a cold machine / CI reuses shared artifacts
    const cacheDir = path.join(projectRoot, '.base/term', 'cache')

    if (input.remote) {
      try {
        const pulled = await pullRemoteCache(
          cacheDir,
          input.remote,
          input.remoteToken,
        )

        if (pulled) {
          console.log(
            fade(
              `  pulled ${pulled} cache artifacts from ${input.remote}`,
            ),
          )
        }
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
    // cache (`.base/term/cache`) makes a cold re-boot reuse the prior parse + mill + compile (Tier 1).
    // resolve modules against the APP dir (the entry's package root, holding `deck.tree`), not the link/cache
    // `projectRoot`, so the app's own `@scope/...` and relative imports resolve correctly.
    const resolve = projectResolver(
      appDir ?? projectRoot,
      env,
      installRoot,
    )

    // the program name a command-line tool prints in its usage and help
    // lines: the tail of the `deck <name>` declaration in the app's
    // deck.tree (`@term/zone` names the `zone` binary), falling back to
    // the entry file's directory name
    const binName = ((): string => {
      const deckFile = path.join(appDir ?? projectRoot, 'deck.tree')

      if (existsSync(deckFile)) {
        const m = /^deck\s+(\S+)/m.exec(readFileSync(deckFile, 'utf8'))
        const tail = m?.[1]?.split('/').pop()

        if (tail) {
          return tail.replace(/\.tree$/, '')
        }
      }

      return path.basename(path.dirname(entry))
    })()

    // the server runs as a MANAGED CHILD process so the dev watcher can rebuild and restart it on an app-code edit. The
    // port is chosen ONCE (here) so every restart re-binds the same address.
    const port = input.port ?? (await findFreePort(BASE_PORT))
    const serverCwd = appDir ?? projectRoot
    const dev = process.env.NODE_ENV !== 'production'

    // ONE persistent cache, reused across every rebuild (exactly as `seed make --watch` does). It is the turborepo-style
    // content-addressed store at `.base/term/cache`: the in-memory layer survives across rebuilds in this process, and the
    // disk layer survives across runs and machines (and a remote, via pull/push above). So an unchanged module reuses
    // its parse + mill, and an unchanged graph returns its whole result instantly -- the same reuse `seed make` gets.
    const cache = projectCache(projectRoot)

    // build the app ONCE: compile the entry, (re)build the client bundle + styles, bundle to ESM, and write the run
    // entry `run.mjs`. Returns its path plus whether the program is a command-line tool (top-level `hook` commands),
    // or null on a compile error (the rich diagnostics are printed and any running server is left up). This is the
    // SAME incremental compile (shared `.base/term/cache`) and the SAME diagnostic renderer (`report.ts`) that
    // `seed make` uses; only the output step (esbuild bundle + run entry) differs.
    const buildOnce = async (): Promise<{
      run: string
      cli: boolean
    } | null> => {
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

        return null
      }

      // a program whose top level declares `hook` commands is a command-line
      // tool: it gets a dispatching run entry instead of the server harness,
      // and none of the SSR client machinery
      const cliRoutes = commandRoutes(result.program)
      const cli = cliRoutes.length > 0

      // for an SSR server (the node host), also build the browser CLIENT bundle the rendered page loads, so the
      // server-rendered HTML becomes interactive. The app must have a deck.tree root (appDir) to hold `build/`.
      if (!cli && env === 'node' && appDir) {
        const prod = process.env.NODE_ENV === 'production'
        buildStyles(appDir)
        await buildClientBundle({
          entry,
          appDir,
          projectRoot,
          installRoot,
          prod,
        })
        // content-hash the cache-bust-critical assets and write the manifest the shell reads
        hashAssets(path.join(appDir, 'build'), prod)
        // bump the dev live-reload id (the client polls /base/__id and reloads when it changes)
        writeBuildId(appDir)
      }

      // auto-prepend the native runtime shims this program docks. This is the prelude the build owns.
      const prelude = nativePrelude(result.program, env, p =>
        existsSync(p) ? readFileSync(p, 'utf8') : undefined,
      )

      const source = `${prelude}\n${result.typescript}`

      const bundleConfig = {
        bundle: true,
        format: 'esm' as const,
        platform:
          env === 'browser' ? ('browser' as const) : ('node' as const),
        packages: 'external' as const,
        // native `case node` templates call `require(...)`. The output
        // is ESM, where esbuild's require shim just throws - so give
        // node bundles a real one. Browser bundles get none: a
        // `require` there is a genuine error.
        ...(env === 'browser'
          ? {}
          : {
              banner: {
                // ANCHORED AT THE PROJECT, NOT THE BUNDLE.
                //
                // The bundle lives in `.base/term/boot/<hash>/`, so a
                // `require` made from `import.meta.url` resolves relative
                // paths under that directory and finds a project's own
                // node_modules only by walking up past it. A runtime shim
                // that needs to reach the project -- to call the compiler's
                // own reader, say -- then cannot, and the failure reads as a
                // missing module rather than as a resolution base.
                //
                // Anchoring at the project root makes both work: a relative
                // path is relative to the project, and a package name
                // resolves through the project's dependencies.
                js:
                  `import { createRequire as __createRequire } from 'node:module'\n` +
                  `const require = __createRequire(${JSON.stringify(
                    path.join(projectRoot, 'index.js'),
                  )})`,
              },
            }),
      }

      // incremental cache in `.base/term/boot/<hash>`. The key folds in everything that can change the output.
      const key = hashText(
        [
          BOOT_CACHE_EPOCH,
          compilerVersion(),
          env,
          `esbuild@${esbuildVersion}`,
          JSON.stringify(bundleConfig),
          source,
        ].join('\n'),
      )

      const out = path.join(projectRoot, '.base/term', 'boot', key)
      const bundle = path.join(out, 'app.mjs')

      if (existsSync(bundle)) {
        logGood(
          `Cached ${path.relative(cwd, entry)} (.base/term/boot/${key.slice(0, 8)})`,
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
          `Built ${path.relative(cwd, entry)} -> .base/term/boot/${key.slice(0, 8)}`,
        )
      }

      // link the CLI install's node_modules next to the bundle so ESM resolves the external bare specifiers
      const bundleModules = path.join(out, 'node_modules')
      const installModules = path.join(installRoot, 'node_modules')

      if (!existsSync(bundleModules) && existsSync(installModules)) {
        try {
          symlinkSync(installModules, bundleModules, 'dir')
        } catch {
          // a pre-existing link or a race is fine
        }
      }

      if (cli) {
        // the dispatch engine, placed beside the app so the generated
        // entry and the compiler share ONE implementation of parsing,
        // help, and execution. The published CLI ships it prebuilt as
        // `host/dock.mjs` (see make:line); a source checkout builds it
        // from hook-dispatch.ts directly. Refreshed every build: it is
        // milliseconds, and a stale copy after an upgrade is a real bug.
        const here = path.dirname(fileURLToPath(import.meta.url))
        const shipped = path.join(here, 'dock.mjs')

        if (existsSync(shipped)) {
          copyFileSync(shipped, path.join(out, 'dock.mjs'))
        } else {
          buildSync({
            entryPoints: [
              path.join(here, '../deck/call/code/hook-dispatch.ts'),
            ],
            outfile: path.join(out, 'dock.mjs'),
            bundle: true,
            format: 'esm',
            platform: 'node',
            packages: 'external',
          })
        }

        // the route tree the program declared, embedded as data. Spans
        // are dropped: the runner never reports source positions.
        const routes = JSON.stringify(cliRoutes, (key, value) =>
          key === 'span' ? undefined : (value as unknown),
        )

        writeFileSync(
          path.join(out, 'run.mjs'),
          [
            `import * as app from './app.mjs'`,
            `import { runCommandLine, toCamel } from './dock.mjs'`,
            `const routes = ${routes}`,
            `const code = await runCommandLine({`,
            `  name: ${JSON.stringify(binName)},`,
            `  routes,`,
            `  argv: process.argv.slice(2),`,
            `  resolve: task => app[toCamel(task)],`,
            `})`,
            `process.exit(code)`,
            '',
          ].join('\n'),
        )

        return { run: path.join(out, 'run.mjs'), cli: true }
      }

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

      return { run: path.join(out, 'run.mjs'), cli: false }
    }

    const built = await buildOnce()

    if (!built) {
      process.exit(1)
    }

    const runPath = built.run

    // a command-line program runs ONCE with the forwarded arguments and
    // exits with the command's own code. No port, no watcher, no server
    // lifecycle - `term boot cli.tree -- show` behaves like `zone show`.
    if (built.cli) {
      // A command-line tool runs in the USER'S cwd, not the app dir. A
      // server needs the app dir (its `build/` and `deck.tree` live
      // there), but a CLI resolves the user's relative paths -- a
      // `.zone.tree` in the directory they invoked from, an output
      // file they named -- so it must inherit the invocation cwd.
      const child = spawn(
        'node',
        [runPath, ...(input.args ?? [])],
        { cwd: input.root, stdio: 'inherit' },
      )

      const code = await new Promise<number>(done =>
        child.once('exit', c => done(c ?? 1)),
      )

      process.exit(code)
    }

    // push freshly-built artifacts to the remote (Tier 5), once, after the first successful build
    if (input.remote) {
      try {
        const pushed = await pushRemoteCache(
          cacheDir,
          input.remote,
          input.remoteToken,
        )

        if (pushed) {
          console.log(
            fade(`  pushed ${pushed} cache artifacts to ${input.remote}`),
          )
        }
      } catch {
        // a remote-cache failure must never fail the build
      }
    }

    logGood(`Serving on http://localhost:${port}`)
    console.log(fade(`  press ctrl-c to stop`))

    // the server child: spawned now from the APP dir (where deck.tree + build/ live), killed + respawned by the dev
    // watcher on an app-code rebuild.
    let child: ChildProcess = spawn('node', [runPath], {
      cwd: serverCwd,
      stdio: 'inherit',
    })

    // restart the server on a freshly-built entry: wait for the old process to fully EXIT (releasing the port) before
    // binding the new one, so a restart never races into EADDRINUSE. If the child already exited on its own (a crash),
    // there is nothing to wait for.
    const restart = async (next: string): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(done => {
          child.once('exit', () => done())
          child.kill()
        })
      }

      child = spawn('node', [next], { cwd: serverCwd, stdio: 'inherit' })
    }

    const stops: Array<() => void> = []

    if (dev && appDir) {
      // styles hot-reload (look.css -> bump reload id), as before
      stops.push(watchStyles(appDir))

      // APP-CODE hot reload: on a `.tree` edit anywhere in the app, recompile + rebundle + restart the server. This is
      // the SAME debounced, no-overlap watcher (`watchTreeFiles`) that `seed make --watch` uses -- the recompilation
      // machinery is shared, only the build step differs. A compile error keeps the running server up (diagnostics
      // printed). Generated / dependency dirs are ignored.
      const codeWatcher = watchTreeFiles(
        appDir,
        async name => {
          logStep(`change in ${name}, rebuilding...`)
          const next = await buildOnce()

          if (next) {
            await restart(next.run)
            logGood('reloaded')
          }
        },
        ['build/', '.base/term/', 'node_modules/', 'host/'],
      )
      stops.push(() => codeWatcher.close())

      console.log(fade('  hot reload on (watching app code + styles)'))
    }

    // keep the CLI alive; ctrl-c stops the watchers and the server child
    const shutdown = (): void => {
      for (const stop of stops) {
        stop()
      }

      try {
        child.kill()
      } catch {
        // already gone
      }

      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    if (stops.length > 0) {
      // dev: the watchers own the server child's lifecycle (rebuild -> restart), so stay alive until a signal
      await new Promise<void>(() => {})
    } else {
      // production / no-watch: run until the server child exits, then return (matching a plain `node run.mjs`)
      await new Promise<void>(done => child.once('exit', () => done()))
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
