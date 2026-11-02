// What `term test` and `term boot` share of bundling a program, and the dev harness's way into the test runner. The runner
// is work/testing/test-running.tree, which builds a test file and runs it as a child reporting to a file (decision 022
// T5). See note/library/seed/test-dsl.md.

import {
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { Plugin } from 'esbuild'
import { nodeBanner } from '@term/call/code/boot-plan'
import { runTestFile as runInChild } from '@term/call/code/work/testing/test-running'
import type { NativeEnv } from '@term/make/code/compile/native'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Resolver } from '@term/make/code/compile/load'
import type { RoleOf } from '@term/call/code/role-of'
import type { Snapshots } from '@term/call/code/test-preprocess'

// one test: whether it held, how long it took in milliseconds, and the error it threw when it threw one
export type TestResult = {
  name: string
  label: string
  held: boolean
  ms?: number
  error?: string
  line?: number
}
export type TestRun = {
  ok: boolean
  results: TestResult[]
  failure?: string
  // the diagnostics behind a failure, whole, and the compiled text their spans point into
  diagnostics?: Diagnostic[]
  text?: string
  // under `term test --update`, what each test's `want snapshot`s saw, by its phrase
  taken?: Map<string, string[]>
  // what the file's child printed
  printed?: string[]
}

// one test file built whole and run as a child (the dev harness, test/tree/run.ts): `term test` calls the port itself
export async function runTestFile(input: {
  file: string
  source: string
  resolve: Resolver
  env: NativeEnv
  readRuntime: (path: string) => string | undefined
  roleOf?: RoleOf
  leanOf?: (file: string) => boolean
  select?: (test: { name: string; label: string }) => boolean
  snapshots?: Snapshots
  limit?: number
}): Promise<TestRun> {
  return (await runInChild(input)) as unknown as TestRun
}

// ---- a program's docks, resolved as the project's own build resolves them (decision 009) ----
//
// `term test` and `term boot` bundle a program INSIDE its project and resolve every bare dock by one rule: a specifier
// the project's nearest tsconfig.json `paths` maps is inlined from source, as make:line inlines a port that docks
// `@term/make/code/...`, and every other bare one stays external and resolves from the project at run time (its own
// node_modules, then the install's linked beside the module). A module in os.tmpdir() found neither.

// the nearest tsconfig.json at or above `root`, none when no folder up to the disk's root holds one
export function nearestTsconfig(root: string): string | undefined {
  let dir = root

  for (;;) {
    const file = join(dir, 'tsconfig.json')

    if (existsSync(file)) {
      return file
    }

    const up = dirname(dir)

    if (up === dir) {
      return undefined
    }

    dir = up
  }
}

// a tsconfig's text as JSON: its comments and trailing commas taken out, strings kept whole
function tsconfigJson(text: string): Record<string, unknown> {
  let out = ''
  let at = 0

  while (at < text.length) {
    const char = text[at]!

    if (char === '"') {
      let end = at + 1

      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1
      }

      out += text.slice(at, end + 1)
      at = end + 1
    } else if (char === '/' && text[at + 1] === '/') {
      while (at < text.length && text[at] !== '\n') {
        at++
      }
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2)
      at = end < 0 ? text.length : end + 2
    } else {
      out += char
      at++
    }
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<
    string,
    unknown
  >
}

// the specifiers a tsconfig's `paths` maps, each key as written (`@term/make/*`), following a relative `extends` (eight
// deep at most) when a file has no `paths`. Unreadable: none
export function tsconfigPathKeys(tsconfig: string): string[] {
  let file = tsconfig

  try {
    for (let depth = 0; depth < 8; depth++) {
      const json = tsconfigJson(readFileSync(file, 'utf8'))
      const options = (json.compilerOptions ?? {}) as {
        paths?: Record<string, unknown>
      }

      if (options.paths !== undefined) {
        return Object.keys(options.paths)
      }

      const base =
        typeof json.extends === 'string' && json.extends.startsWith('.')
          ? json.extends
          : ''

      if (base === '') {
        return []
      }

      file = resolvePath(
        dirname(file),
        base.endsWith('.json') ? base : `${base}.json`,
      )

      if (!existsSync(file)) {
        return []
      }
    }
  } catch {
    // unreadable: none
  }

  return []
}

// whether a `paths` key maps a specifier: `x/*` every specifier under `x/`, a key with no star that one alone
export function pathKeyMaps(key: string, specifier: string): boolean {
  const star = key.indexOf('*')

  if (star < 0) {
    return specifier === key
  }

  return (
    specifier.length >= key.length - 1 &&
    specifier.startsWith(key.slice(0, star)) &&
    specifier.endsWith(key.slice(star + 1))
  )
}

// the esbuild options of a bundle that resolves its docks by the rule: the tsconfig, and a plugin that leaves a mapped
// specifier to esbuild (which applies the tsconfig's paths) and marks every other bare one external. esbuild's own
// `packages: 'external'` is not used: it decides by the specifier's look, before any tsconfig
export function dockOptions(root: string): {
  tsconfig?: string
  plugins: Plugin[]
} {
  const tsconfig = nearestTsconfig(root)
  const keys = tsconfig ? tsconfigPathKeys(tsconfig) : []
  const plugin: Plugin = {
    name: 'term-docks',
    setup(on) {
      // a bare specifier: neither relative nor absolute
      on.onResolve({ filter: /^[^./]/ }, args => {
        if (
          isAbsolute(args.path) ||
          keys.some(key => pathKeyMaps(key, args.path))
        ) {
          return undefined
        }

        return { path: args.path, external: true }
      })
    },
  }

  return { ...(tsconfig ? { tsconfig } : {}), plugins: [plugin] }
}

// the `require` a node bundle is given, anchored at the project and not the bundle (boot-plan.tree `node-banner`)
export function projectBanner(root: string): string {
  return nodeBanner(JSON.stringify(join(root, 'index.js')))
}

// one source a bundle inlined, and its content's hash
export type InlinedSource = { path: string; hash: string }

// the content hash of each file read this process, by path, size and time, so a warm run reads a file it inlined once
const HASHES = new Map<
  string,
  { size: number; time: number; hash: string }
>()

// a file's content hash, the empty text when it cannot be read
export function sourceHash(file: string): string {
  try {
    const stat = statSync(file)
    const known = HASHES.get(file)

    if (known?.size === stat.size && known.time === stat.mtimeMs) {
      return known.hash
    }

    const hash = createHash('sha256')
      .update(readFileSync(file))
      .digest('hex')

    HASHES.set(file, { size: stat.size, time: stat.mtimeMs, hash })

    return hash
  } catch {
    return ''
  }
}

// a program bundled by the rule: its text, and every source outside `own` (the folder its entry was written in) that it
// inlined, with each one's hash, which a kept bundle is checked against
export async function bundleDocks(input: {
  root: string
  entry: string
  own: string
  banner?: string
  platform?: 'node' | 'browser'
}): Promise<{ text: string; inlined: InlinedSource[] }> {
  const bundled = await build({
    entryPoints: [input.entry],
    absWorkingDir: input.root,
    bundle: true,
    format: 'esm',
    platform: input.platform ?? 'node',
    write: false,
    metafile: true,
    ...dockOptions(input.root),
    ...(input.banner ? { banner: { js: input.banner } } : {}),
  })

  const inlined: InlinedSource[] = []

  for (const key of Object.keys(bundled.metafile.inputs).sort()) {
    const file = resolvePath(input.root, key)
    const inside = relative(input.own, file)

    // the program's own modules are named by the key it is kept under; a namespaced input is no file
    if (
      (!inside.startsWith('..') && !isAbsolute(inside)) ||
      key.includes(':')
    ) {
      continue
    }

    const hash = sourceHash(file)

    if (hash !== '') {
      inlined.push({ path: file, hash })
    }
  }

  return { text: bundled.outputFiles[0]!.text, inlined }
}

// whether every source a kept bundle inlined still holds what it held
export function inlinedHold(inlined: InlinedSource[]): boolean {
  return inlined.every(one => sourceHash(one.path) === one.hash)
}

// the node_modules of the toolchain running this, linked beside a module so a dock the project does not carry resolves
// through the install (call/code/boot.ts does the same beside a boot bundle)
export function linkInstallModules(dir: string): void {
  const install = installModules()
  const beside = join(dir, 'node_modules')

  if (install === undefined || existsSync(beside)) {
    return
  }

  try {
    symlinkSync(install, beside, 'dir')
  } catch {
    // a link made meanwhile, or none allowed: the project's own node_modules still resolve
  }
}

// the nearest node_modules above this module: the install's, or the checkout's
function installModules(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))

  for (;;) {
    const at = join(dir, 'node_modules')

    if (existsSync(at)) {
      return at
    }

    const up = dirname(dir)

    if (up === dir) {
      return undefined
    }

    dir = up
  }
}
