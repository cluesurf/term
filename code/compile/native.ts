// Per-env native resolution. A public stdlib module forwards to an ABSTRACT native module (`.../native/<name>`); this
// wrapper rewrites that to the concrete per-platform impl (`.../native/<env>/<name>`) for the target the build is
// compiling for. So a public `file.tree` can `load @cluesurf/base/code/native/file` and the build picks node /
// browser / rust / swift — the user only ever sees the uniform public API and never names a platform. An import that
// is already env-qualified (`.../native/node/...`) is left alone. See feedback_stdlib_clean_api_dock_native.

import type { Resolver, Source } from '@/code/compile/load'

// the platforms a native module can target; an import already under one of these is concrete, not abstract
export const NATIVE_ENVS = ['node', 'browser', 'rust', 'swift', 'javascript', 'kotlin', 'shared'] as const
export type NativeEnv = (typeof NATIVE_ENVS)[number]

// rewrite an abstract native import to the env-specific one, or return undefined if it is not an abstract native path
export function nativeImportFor(importPath: string, env: NativeEnv): string | undefined {
  const match = importPath.match(/^(.*\/native)\/([^/]+)(\/.*)?$/)
  if (!match) return undefined
  const segment = match[2]!
  if ((NATIVE_ENVS as ReadonlyArray<string>).includes(segment)) return undefined // already concrete (e.g. native/node/...)
  return `${match[1]}/${env}/${segment}${match[3] ?? ''}`
}

// wrap a resolver so that abstract native imports resolve to the chosen platform's implementation. The env-specific
// module is preferred; if it does not exist, the original path is tried (so a not-yet-ported module still resolves).
export function withNativeEnv(env: NativeEnv, base: Resolver): Resolver {
  return (importPath: string, fromFile: string): Source | undefined => {
    const rewritten = nativeImportFor(importPath, env)
    if (rewritten) {
      const resolved = base(rewritten, fromFile)
      if (resolved) return resolved
    }
    return base(importPath, fromFile)
  }
}
