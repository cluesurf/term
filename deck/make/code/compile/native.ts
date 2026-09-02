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
  // the page inside a native app cask: TypeScript in the platform WebView, reaching every native through the
  // cask's bridge. Borrows the browser natives for everything that is pure page work. See note/term/cask/readme.md
  'webview',
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
  webview: 'ts',
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
): { name: string; alias: string; file?: string }[] {
  const docks: { name: string; alias: string; file?: string }[] = []

  for (const node of program) {
    if (node.form === 'native' && node.module.startsWith('global:')) {
      docks.push({
        name: node.module.slice('global:'.length),
        // THE ALIAS IS WHAT THE EMITTED CODE SAYS. `load <global:walk>, name walk-file` puts the shim in
        // `runtime/walk.<ext>` (the global names the FILE) and every call reads `walkFile::...` (the alias names
        // the NAMESPACE). The two are the same word most of the time, which is why nothing noticed until a dock
        // had to be aliased away from a stdlib name it collided with.
        alias: node.alias,
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

// does the emitted source mention this dock's namespace, under any of the spellings a backend gives it? A kebab
// alias is emitted camelCase on swift / kotlin / typescript and snake_case on rust, and the raw kebab is never an
// identifier, so all three are tried rather than the one the caller happened to write.
function mentions(source: string, alias: string): boolean {
  const camel = alias.replace(/-([a-z0-9])/g, (_, c: string) =>
    c.toUpperCase(),
  )
  const snake = alias.replace(/-/g, '_')

  for (const spelling of new Set([alias, camel, snake])) {
    const word = spelling.replace(/[^\w]/g, '\\$&')

    if (new RegExp(`\\b${word}\\b`).test(source)) {
      return true
    }
  }

  return false
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

  for (const { name, alias, file } of globalDocks(program)) {
    // Skip a dock whose namespace is unreferenced in the emitted code (keeps unused native deps out of the
    // bundle). TESTED AGAINST THE ALIAS, not the global: the alias is the identifier the emitted code actually
    // holds. Testing the global drops the shim of any dock that was renamed, the bundle builds clean, and the
    // first call dies with `ReferenceError: <alias> is not defined`.
    //
    // The alias is spelled in the emitted code the way that backend spells an identifier (`walk-file` is
    // `walkFile` on swift and kotlin, `walk_file` on rust), so all three spellings are tried.
    if (usedIn !== undefined && !mentions(usedIn, alias)) {
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

    // a SHARED module (`code/hold/hash/fnv.tree`, `code/native/shared/...`) docks a global whose shim lives
    // under the target platform's own runtime dir: derive `<pkg>/code/native/<env>/runtime/<name>` from the
    // docking file's path, since the upward walk from a shared dir never reaches another platform's tree
    if (file) {
      const at = file.lastIndexOf('/code/')

      if (at >= 0) {
        candidates.push(
          `${file.slice(0, at)}/code/native/${env}/runtime/${name}.${RUNTIME_EXTENSION[env]}`,
        )
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

  // the empty statement is JavaScript's: Rust and Swift refuse a bare `;` at the top of a file, and their shims are
  // items, never expression statements, so a newline is the whole separator there
  const glue = env === 'node' || env === 'browser' ? ';\n' : '\n'

  return env === 'node' || env === 'browser'
    ? `${glue}${parts.join(`\n${glue}`)}`
    : parts.join(`\n${glue}`)
}

// a target that shares another env's native impls where it has none of its own. The Cloudflare Workers runtime is V8
// with Web APIs (String / Array / fetch / crypto), so it reuses the `browser` native stdlib wholesale; only the few
// SSR seams that genuinely differ (the in-memory DOM, the fetch-handler transport + host) ship a `native/cloudflare`
// file, which still wins because it is tried first. Without this every pure-JS stdlib module (text, list, ...) would
// need a hand-written `native/cloudflare` re-export.
export const NATIVE_ENV_FALLBACK: Partial<Record<NativeEnv, NativeEnv>> = {
  cloudflare: 'browser',
  // the page in a cask is a browser page whose natives go over the bridge; the DOM, text, list and the rest are the
  // browser's own
  webview: 'browser',
}

// wrap a resolver so that abstract native imports resolve to the chosen platform's implementation. The env-specific
// module is preferred; then a sibling-env fallback (cloudflare -> browser); then the original path (so a not-yet-ported
// module still resolves).
export function withNativeEnv(
  env: NativeEnv,
  base: Resolver,
): Resolver {
  return (importPath: string, fromFile: string): Source | undefined => {
    // the explicit spelling: `load .../native/{platform}/<name>` says on its face that the path is chosen by the
    // target. The env fills the slot; an env with no impl of its own borrows its sibling's (cloudflare -> browser)
    if (importPath.includes('{platform}')) {
      const fallbackEnv = NATIVE_ENV_FALLBACK[env]

      for (const candidate of fallbackEnv ? [env, fallbackEnv] : [env]) {
        const resolved = base(
          importPath.replaceAll('{platform}', candidate),
          fromFile,
        )

        if (resolved) {
          return resolved
        }
      }

      // no impl for this env: the abstract module itself, when one exists (`native/serve.tree` beside the env
      // dirs holds the shared fallback), the way the retired implicit rewrite fell back to the original path
      return base(
        importPath.replaceAll('/{platform}', ''),
        fromFile,
      )
    }

    // the implicit rewrite (`.../native/<name>` -> `.../native/<env>/<name>`) is RETIRED (stdlib-parity-0002):
    // every public stdlib module now spells `native/{platform}/<name>` explicitly, so an abstract path resolves
    // as written or not at all
    return base(importPath, fromFile)
  }
}
