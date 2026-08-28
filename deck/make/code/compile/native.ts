// Per-env native resolution. A public stdlib module forwards to an ABSTRACT native module (`.../native/<name>`); this
// wrapper rewrites that to the concrete per-platform impl (`.../native/<env>/<name>`) for the target the build is
// compiling for. So a public `file.tree` can `load @cluesurf/seed/code/native/file` and the build picks node /
// browser / rust / swift — the user only ever sees the uniform public API and never names a platform. An import that
// is already env-qualified (`.../native/node/...`) is left alone. See feedback_stdlib_clean_api_dock_native.

import type { Resolver, Source } from '@term/make/code/compile/load'
import type { Program } from '@term/make/code/compile/node'

// the platforms a native module can target; an import already under one of these is concrete, not abstract
export const NATIVE_ENVS = [
  'node',
  'browser',
  'cloudflare',
  'rust',
  'swift',
  'javascript',
  'kotlin',
  'shared',
] as const
export type NativeEnv = (typeof NATIVE_ENVS)[number]

// the file extension a target's native runtime source uses
export const RUNTIME_EXTENSION: Record<NativeEnv, string> = {
  node: 'ts',
  browser: 'ts',
  // the Cloudflare Workers target: TypeScript like node/browser, but its native runtime
  // shims speak the Web platform (a Fetch handler + the ASSETS binding, no node http socket)
  cloudflare: 'ts',
  javascript: 'ts',
  rust: 'rs',
  swift: 'swift',
  kotlin: 'kt',
  shared: 'txt',
}

// ---- native runtime preludes ----
// Some compiled targets reach a capability through a small `<global:X>` runtime shim (a namespace of total functions
// wrapping the platform library: `io`, `math`, `crypto`, `text`). That shim source is NOT in the compiler. It lives in
// the stdlib at `native/<env>/runtime/<X>.<ext>`. This collector is generic: it gathers the `<global:X>` namespaces a
// program docks, and for each one whose runtime file exists it returns that source. The compiler holds the convention
// (where runtime files live, per-target extension), never the content. The build prepends the prelude before emit.

// the `<global:X>` docks in a program: the namespace name plus the module file the dock lives in (so its runtime shim
// can be found next to that module). The candidates for a runtime-shim prelude.
export function globalDocks(
  program: Program,
): { name: string; file?: string }[] {
  const docks: { name: string; file?: string }[] = []

  for (const node of program) {
    if (node.form === 'native' && node.module.startsWith('global:')) {
      docks.push({
        name: node.module.slice('global:'.length),
        file: node.file,
      })
    }
  }

  return docks
}

// the distinct namespace names a program docks (kept for callers that only need names)
export function globalDockNames(program: Program): string[] {
  return [...new Set(globalDocks(program).map(d => d.name))]
}

// the posix directory of a path (the resolver yields posix paths; native.ts stays browser-safe, no node `path`)
// How far up from a docking module to look for its runtime shim. Four covers
// `native/<env>/<group>/<module>.tree` with room to spare, and stops the walk
// well short of the filesystem root.
const RUNTIME_SEARCH_DEPTH = 4

function directoryOf(file: string): string {
  const i = file.lastIndexOf('/')

  return i >= 0 ? file.slice(0, i) : '.'
}

// a runtime shim lives next to the module that docks it: `<dir-of-module>/runtime/<name>.<ext>`. This is the primary
// location, so a shim is found in whatever package its impl lives in (base.tree, site.tree, an app, ...).
export function runtimePathFor(
  file: string,
  env: NativeEnv,
  name: string,
): string {
  return `${directoryOf(file)}/runtime/${name}.${RUNTIME_EXTENSION[env]}`
}

// the stdlib import path of a target's runtime shim for a namespace (the fallback when a dock has no recorded origin)
export function runtimePath(env: NativeEnv, name: string): string {
  return `@cluesurf/seed/code/native/${env}/runtime/${name}.${RUNTIME_EXTENSION[env]}`
}

// build the native prelude for a target: the concatenation of every runtime-shim file the program's global docks
// reference and that actually exists. Each shim is looked up next to the module that docks it (its origin file), with
// the base.tree path as a fallback. `readRuntime(path)` returns the raw source for a runtime path, or undefined.
export function nativePrelude(
  program: Program,
  env: NativeEnv,
  readRuntime: (path: string) => string | undefined,
  // the emitted code the prelude will sit in front of. When given, a shim is included only if its global token actually
  // appears there, so a dock the program never calls (e.g. floating-ui `position` in an app that mounts no panels) does
  // not pull its third-party dependency into the bundle. Omit to include every dock (the conservative default).
  usedIn?: string,
): string {
  const parts: string[] = []
  const added = new Set<string>()

  for (const { name, file } of globalDocks(program)) {
    // skip a dock whose global is unreferenced in the emitted code (keeps unused native deps out of the bundle)
    if (
      usedIn !== undefined &&
      !new RegExp(`\\b${name.replace(/[^\w]/g, '\\$&')}\\b`).test(
        usedIn,
      )
    ) {
      continue
    }

    // A shim lives at `<dir>/runtime/<name>`, and the dock that names it is
    // not always in that directory. `native/node/bytes.tree` docks `octets`
    // and its shim is one level down at `native/node/runtime/bytes.ts`, but
    // `native/node/cryptography/cipher.tree` docks `cipher` whose shim is at
    // `native/node/runtime/cipher.ts`, two levels up from the docking module.
    //
    // So each directory on the way up is tried, not only the docking module's
    // own. Without this every nested native module silently loses its shim:
    // the bundle builds, and the program dies at runtime with
    // `ReferenceError: cipher is not defined` the first time it calls one.
    // That took out the whole `cryptography` surface under `term boot`.
    //
    // `runtimePath` stays last as a fallback, though callers that resolve by
    // filesystem path cannot use it: it returns a package import path.
    const candidates: string[] = []

    if (file) {
      let dir = directoryOf(file)

      for (let up = 0; up < RUNTIME_SEARCH_DEPTH; up += 1) {
        candidates.push(
          `${dir}/runtime/${name}.${RUNTIME_EXTENSION[env]}`,
        )

        const above = directoryOf(dir)

        if (above === dir || above === '.') {
          break
        }

        dir = above
      }
    }

    candidates.push(runtimePath(env, name))

    for (const candidate of candidates) {
      if (added.has(candidate)) {
        break
      }

      const source = readRuntime(candidate)

      if (source !== undefined) {
        added.add(candidate)
        parts.push(source)
        break
      }
    }
  }

  // JOINED WITH SEMICOLONS, DELIBERATELY.
  //
  // Nothing here emits a trailing semicolon, and neither does the program
  // these shims are appended to. A shim whose body starts with `(` -- the
  // ordinary `(function () { ... })()` wrapper -- then continues the
  // previous statement instead of starting a new one:
  //
  //   const out = showFile(whole)      <- emitted program, no semicolon
  //   (function () { ... })()          <- shim
  //
  // JavaScript reads that as `showFile(whole)(function...)`, calling the
  // result of showFile. It compiles clean and dies at runtime somewhere
  // unrelated, which is the worst way for a compiler to be wrong.
  //
  // A leading `;` cannot change the meaning of anything that was already
  // correct: it is an empty statement. So every part is preceded by one.
  if (parts.length === 0) {
    return ''
  }

  return `;\n${parts.join('\n;\n')}`
}

// rewrite an abstract native import to the env-specific one, or return undefined if it is not an abstract native path
export function nativeImportFor(
  importPath: string,
  env: NativeEnv,
): string | undefined {
  const match = /^(.*\/native)\/([^/]+)(\/.*)?$/.exec(importPath)

  if (!match) {
    return undefined
  }

  const segment = match[2]!

  if ((NATIVE_ENVS as readonly string[]).includes(segment)) {
    return undefined
  } // already concrete (e.g. native/node/...)

  return `${match[1]}/${env}/${segment}${match[3] ?? ''}`
}

// a target that shares another env's native impls where it has none of its own. The Cloudflare Workers runtime is V8
// with Web APIs (String / Array / fetch / crypto), so it reuses the `browser` native stdlib wholesale; only the few
// SSR seams that genuinely differ (the in-memory DOM, the fetch-handler transport + host) ship a `native/cloudflare`
// file, which still wins because it is tried first. Without this every pure-JS stdlib module (text, list, ...) would
// need a hand-written `native/cloudflare` re-export.
const NATIVE_ENV_FALLBACK: Partial<Record<NativeEnv, NativeEnv>> = {
  cloudflare: 'browser',
}

// wrap a resolver so that abstract native imports resolve to the chosen platform's implementation. The env-specific
// module is preferred; then a sibling-env fallback (cloudflare -> browser); then the original path (so a not-yet-ported
// module still resolves).
export function withNativeEnv(
  env: NativeEnv,
  base: Resolver,
): Resolver {
  return (importPath: string, fromFile: string): Source | undefined => {
    const rewritten = nativeImportFor(importPath, env)

    if (rewritten) {
      const resolved = base(rewritten, fromFile)

      if (resolved) {
        return resolved
      }

      // this env has no impl for the module: try a sibling env that it borrows its native stdlib from
      const fallbackEnv = NATIVE_ENV_FALLBACK[env]

      if (fallbackEnv) {
        const viaFallback = nativeImportFor(importPath, fallbackEnv)

        if (viaFallback) {
          const resolvedFallback = base(viaFallback, fromFile)

          if (resolvedFallback) {
            return resolvedFallback
          }
        }
      }
    }

    return base(importPath, fromFile)
  }
}
