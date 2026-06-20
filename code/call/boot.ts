import path from 'path'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'fs'
import { buildSync, version as esbuildVersion } from 'esbuild'
import { compile } from '../compile/compile'
import { projectResolver, resolveTreeFile } from './make'
import { nativePrelude } from '../compile/native'
import type { NativeEnv } from '../compile/native'
import { hashText } from '../compile/cache'
import { projectCache } from './cache-store'
import { pullRemoteCache, pushRemoteCache } from './remote-cache'
import { toConstant } from '../compile/typescript'
import { parse } from '../parser/tree'
import type { GroupNode } from '../parser/tree'
import { runCommand } from './make'
import { logStep, logGood, logFail, formatError, fade } from '../tint'

// the head name of a tree group (its first `name` node), and the group's first argument as text. The structured way to
// read a `.tree` file (mirrors the helpers in code/deck/install.ts).
function nodeHead(group: GroupNode): string | undefined {
  const first = group.nodes[0]
  return first && first.kind === 'name'
    ? first.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join('')
    : undefined
}
function nodeValue(group: GroupNode): string {
  const arg = group.nodes[1]
  if (!arg) return ''
  if (arg.kind === 'text' || arg.kind === 'name')
    return arg.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join('')
  return ''
}

// bump to invalidate every boot cache at once (turborepo's `global_cache_key`). Change this on any boot-pipeline change
// that the per-build hash does not already capture (e.g. a new prelude assembly rule).
const BOOT_CACHE_EPOCH = '1'

// the directory (cwd or an ancestor) that holds the `link/` package links a build resolves through; falls back to cwd
export function findProjectRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, 'link'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return start
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
  if (entry) return resolveEntry(path.resolve(cwd, entry))
  let dir = cwd
  for (;;) {
    const manifest = path.join(dir, 'deck.tree')
    if (existsSync(manifest)) {
      const text = readFileSync(manifest, 'utf8')
      const match = text.match(/(?:^|\n)\s*boot\s+(\S+)/)
      if (match) return resolveEntry(path.resolve(dir, match[1]!))
      return undefined
    }
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

// the app package directory: the nearest ancestor (of the entry, else cwd) holding a `deck.tree` manifest
function findAppDir(start: string): string | undefined {
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, 'deck.tree'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

// load environment variables from `bind/host/base.tree` (the app's host config). It is a structured `.tree` file: a
// `host` group whose kebab children name values (`database-url <...>`). Each kebab key becomes a SCREAMING_SNAKE env
// var (`toConstant`). File values are defaults: anything already in the environment wins, so a shell override applies.
function loadHostEnv(appDir: string): Array<string> {
  const file = path.join(appDir, 'bind', 'host', 'base.tree')
  if (!existsSync(file)) return []
  const result = parse({ file, text: readFileSync(file, 'utf8') })
  if (!result.ok) return []
  const host = result.tree.nodes.find(g => nodeHead(g) === 'host')
  if (!host) return []
  const loaded: Array<string> = []
  for (const node of host.nodes.slice(1)) {
    if (node.kind !== 'group') continue
    const key = nodeHead(node)
    if (!key) continue
    const name = toConstant(key)
    if (process.env[name] !== undefined) continue
    process.env[name] = nodeValue(node)
    loaded.push(name)
  }
  return loaded
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
    if (loadedEnv.length) console.log(fade(`  env: ${loadedEnv.join(', ')} (bind/host/base.tree)`))

    // warm the local cache from a remote (Tier 5) before compiling, so a cold machine / CI reuses shared artifacts
    const cacheDir = path.join(projectRoot, '.seed', 'cache')
    if (input.remote) {
      try {
        const pulled = await pullRemoteCache(cacheDir, input.remote, input.remoteToken)
        if (pulled) console.log(fade(`  pulled ${pulled} cache artifacts from ${input.remote}`))
      } catch {
        // a remote-cache failure must never fail the build
      }
    }

    // compile the entry (and everything it loads) through the package manager, targeting the chosen env. A persistent
    // cache (`.seed/cache`) makes a cold re-boot reuse the prior parse + mill + compile (Tier 1).
    const resolve = projectResolver(projectRoot, env)
    const result = compile(
      { file: entry, text: readFileSync(entry, 'utf8') },
      { resolve, cache: projectCache(projectRoot) },
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
        const pushed = await pushRemoteCache(cacheDir, input.remote, input.remoteToken)
        if (pushed) console.log(fade(`  pushed ${pushed} cache artifacts to ${input.remote}`))
      } catch {
        // a remote-cache failure must never fail the build
      }
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
      platform: (env === 'browser' ? 'browser' : 'node') as 'browser' | 'node',
      packages: 'external' as const,
    }

    // incremental cache in `.seed/boot/<hash>`. The key folds in everything that can change the output: the emitted
    // source (which already reflects the compiler's behavior for this input), the target env, the bundler version, the
    // bundler config, and a manual epoch. So a stale hit cannot survive a toolchain or config change. See
    // note/research/repo/turborepo/07-lessons-for-seed.md.
    const key = hashText(
      [
        BOOT_CACHE_EPOCH,
        env,
        `esbuild@${esbuildVersion}`,
        JSON.stringify(bundleConfig),
        source,
      ].join('\n'),
    )
    const out = path.join(projectRoot, '.seed', 'boot', key)
    const bundle = path.join(out, 'app.mjs')
    if (existsSync(bundle)) {
      logGood(`Cached ${path.relative(cwd, entry)} (.seed/boot/${key.slice(0, 8)})`)
    } else {
      mkdirSync(out, { recursive: true })
      writeFileSync(path.join(out, 'app.ts'), source)
      buildSync({
        entryPoints: [path.join(out, 'app.ts')],
        outfile: bundle,
        ...bundleConfig,
      })
      logGood(`Built ${path.relative(cwd, entry)} -> .seed/boot/${key.slice(0, 8)}`)
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

    console.log(fade(`  running (ctrl-c to stop)...`))
    await runCommand({
      cmd: 'node',
      args: [path.join(out, 'run.mjs')],
      cwd: projectRoot,
    })
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
