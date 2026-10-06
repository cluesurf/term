// Per-env native resolution. A public stdlib module forwards to an ABSTRACT native module (`.../native/<name>`); this
// wrapper rewrites that to the concrete per-platform impl (`.../native/<env>/<name>`) for the target the build is
// compiling for. So a public `file.tree` can `load @term/base/code/native/file` and the build picks node /
// browser / rust / swift — the user only ever sees the uniform public API and never names a platform. An import that
// is already env-qualified (`.../native/node/...`) is left alone. See feedback_stdlib_clean_api_dock_native.
//
// ---- native runtime preludes ----
// Some compiled targets reach a capability through a small `<global:X>` runtime shim (a namespace of total functions
// wrapping the platform library: `io`, `math`, `crypto`, `text`). That shim source is NOT in the compiler. It lives in
// the stdlib at `native/<env>/runtime/<X>.<ext>`. The collector is generic: it gathers the `<global:X>` namespaces a
// program docks, and for each one whose runtime file exists it returns that source. The compiler holds the convention
// (where runtime files live, per-target extension), never the content. The build prepends the prelude before emit.
//
// The rules are Term, compile/runtime-prelude.tree (self-hosting, 2026-10-06), and its header says how each regular
// expression is written out. Why each is shaped as it is:
//   - a dock is TESTED AGAINST ITS ALIAS, not its global: the alias is the identifier the emitted code holds, spelled as
//     written, camelCase (swift, kotlin, typescript) or snake_case (rust). Testing the global dropped the shim of every
//     renamed dock, and the first call died with `ReferenceError: <alias> is not defined`
//   - the docks are taken to a FIXPOINT, each shim taken counting as code: a shim may call another the program never
//     names (Swift's location runtime reads its grant through `nativePermission`)
//   - a shim is looked for in every directory on the way up from the docking module (four levels), the env's own
//     `runtime/<env>/` before the shared `runtime/`, then under the docking package's `code/native/<env>/runtime/` for
//     each env of the chain, then the stdlib's, then the package import path. Without the walk up, every nested native
//     module lost its shim and the whole `cryptography` surface died under `term boot`
//   - a `// runtime-include: <path>` line is replaced by that file, relative to the shim, once, and a missing part fails
//     loudly rather than vanishing
//   - the parts are JOINED WITH SEMICOLONS on JavaScript: a shim that starts with `(` would otherwise continue the
//     program's last statement (`showFile(whole)(function ...)`), which compiles clean and dies somewhere unrelated.
//     Rust and Swift refuse a bare `;` at the top of a file, so a newline is the whole separator there
//   - a TypeScript module's `declare const <name>: any` is dropped where the prelude defines the name, or tsc reads two
//     declarations of one name (TS2451)
// This face reads files through the callbacks it is handed, asks resolve.ts for the stdlib's folder, and throws a
// refused include.

import type { LoadHow, Resolver, Source } from '@term/make/code/compile/load'
import type { Program } from '@term/make/code/compile/node'
import { stdlibBase } from '@term/make/code/resolve'
import * as prelude from '@term/make/code/compile/runtime-prelude'
import type { NativeEnv as Env } from '@term/make/code/compile/native-env'

// the platforms a native module can target, their runtime extensions, fallback chains and docks are Term,
// compile/native-env.tree
export type NativeEnv = Env

type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }

const maybeOf = <T>(value: T | undefined): Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })

// a TypeScript module with its prelude in front, as ONE file
export function joinTypeScriptPrelude(prelude_: string, typescript: string): string {
  return prelude.joinTypeScriptPrelude(prelude_, typescript)
}

// build the native prelude for a target: the concatenation of every runtime-shim file the program's global docks
// reference and that actually exists. `readRuntime(path)` returns the raw source for a runtime path, or undefined.
// `usedIn` is the emitted code the prelude will sit in front of: when given, a shim is included only if its alias
// appears there (or in a shim already taken), so a dock the program never calls does not pull its dependency in. Omit
// it to include every dock
export function nativePrelude(
  program: Program,
  env: NativeEnv,
  readRuntime: (path: string) => string | undefined,
  usedIn?: string,
): string {
  const answer = prelude.nativePrelude(
    program,
    env,
    path => maybeOf(readRuntime(path)),
    maybeOf(usedIn),
    () => maybeOf(stdlibBase()),
  )

  if (answer.form === 'refused') {
    throw new Error(answer.reason)
  }

  return answer.text
}

// wrap a resolver so that abstract native imports resolve to the chosen platform's implementation. A `{platform}` slot
// is filled by each env of the chain (cloudflare -> browser), then the abstract module itself when one exists; an
// import with no slot resolves as written. The implicit rewrite of `.../native/<name>` is RETIRED (stdlib-parity-0002).
// `how` (a `base <dir>` under the load) passes through untouched
export function withNativeEnv(
  env: NativeEnv,
  base: Resolver,
): Resolver {
  return (importPath: string, fromFile: string, how?: LoadHow): Source | undefined => {
    let resolved: Source | undefined

    for (const candidate of prelude.nativeCandidates(env, importPath)) {
      resolved = base(candidate, fromFile, how)

      if (resolved) {
        return resolved
      }
    }

    return resolved
  }
}
