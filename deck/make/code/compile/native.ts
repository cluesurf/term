// Per-env native resolution. A public stdlib module forwards to an ABSTRACT native module (`.../native/<name>`); this
// wrapper rewrites that to the concrete per-platform impl (`.../native/<env>/<name>`) for the target the build is
// compiling for. So a public `file.tree` can `load @cluesurf/base/code/native/file` and the build picks node /
// browser / rust / swift — the user only ever sees the uniform public API and never names a platform. An import that
// is already env-qualified (`.../native/node/...`) is left alone. See feedback_stdlib_clean_api_dock_native.

import type { Resolver, Source } from '@cluesurf/make/code/compile/load'
import type { Program } from '@cluesurf/make/code/compile/node'

// the platforms a native module can target; an import already under one of these is concrete, not abstract
export const NATIVE_ENVS = [
  'node',
  'browser',
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
): Array<{ name: string; file?: string }> {
  const docks: Array<{ name: string; file?: string }> = []
  for (const node of program) {
    if (node.form === 'native' && node.module.startsWith('global:'))
      docks.push({
        name: node.module.slice('global:'.length),
        file: node.file,
      })
  }
  return docks
}

// the distinct namespace names a program docks (kept for callers that only need names)
export function globalDockNames(program: Program): Array<string> {
  return [...new Set(globalDocks(program).map(d => d.name))]
}

// the posix directory of a path (the resolver yields posix paths; native.ts stays browser-safe, no node `path`)
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
  return `@cluesurf/base/code/native/${env}/runtime/${name}.${RUNTIME_EXTENSION[env]}`
}

// build the native prelude for a target: the concatenation of every runtime-shim file the program's global docks
// reference and that actually exists. Each shim is looked up next to the module that docks it (its origin file), with
// the base.tree path as a fallback. `readRuntime(path)` returns the raw source for a runtime path, or undefined.
export function nativePrelude(
  program: Program,
  env: NativeEnv,
  readRuntime: (path: string) => string | undefined,
): string {
  const parts: Array<string> = []
  const added = new Set<string>()
  for (const { name, file } of globalDocks(program)) {
    const candidates = file
      ? [runtimePathFor(file, env, name), runtimePath(env, name)]
      : [runtimePath(env, name)]
    for (const candidate of candidates) {
      if (added.has(candidate)) break
      const source = readRuntime(candidate)
      if (source !== undefined) {
        added.add(candidate)
        parts.push(source)
        break
      }
    }
  }
  return parts.join('\n')
}

// rewrite an abstract native import to the env-specific one, or return undefined if it is not an abstract native path
export function nativeImportFor(
  importPath: string,
  env: NativeEnv,
): string | undefined {
  const match = importPath.match(/^(.*\/native)\/([^/]+)(\/.*)?$/)
  if (!match) return undefined
  const segment = match[2]!
  if ((NATIVE_ENVS as ReadonlyArray<string>).includes(segment))
    return undefined // already concrete (e.g. native/node/...)
  return `${match[1]}/${env}/${segment}${match[3] ?? ''}`
}

// wrap a resolver so that abstract native imports resolve to the chosen platform's implementation. The env-specific
// module is preferred; if it does not exist, the original path is tried (so a not-yet-ported module still resolves).
export function withNativeEnv(
  env: NativeEnv,
  base: Resolver,
): Resolver {
  return (importPath: string, fromFile: string): Source | undefined => {
    const rewritten = nativeImportFor(importPath, env)
    if (rewritten) {
      const resolved = base(rewritten, fromFile)
      if (resolved) return resolved
    }
    return base(importPath, fromFile)
  }
}
