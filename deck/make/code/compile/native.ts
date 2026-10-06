// Per-env native resolution. A public stdlib module forwards to an ABSTRACT native module (`.../native/<name>`); this
// wrapper rewrites that to the concrete per-platform impl (`.../native/<env>/<name>`) for the target the build is
// compiling for. So a public `file.tree` can `load @term/base/code/native/file` and the build picks node /
// browser / rust / swift — the user only ever sees the uniform public API and never names a platform. An import that
// is already env-qualified (`.../native/node/...`) is left alone. See feedback_stdlib_clean_api_dock_native.

import type { LoadHow, Resolver, Source } from '@term/make/code/compile/load'
import type { Program } from '@term/make/code/compile/node'
import { stdlibBase } from '@term/make/code/resolve'
import {
  directoryOf,
  envChain,
  globalDocks,
  runtimeExtension,
  runtimePath,
} from '@term/make/code/compile/native-env'
import type { NativeEnv as Env } from '@term/make/code/compile/native-env'

// the platforms a native module can target, their runtime extensions, fallback chains and docks are Term,
// compile/native-env.tree. What stays here reads files through the callbacks it is handed
export type NativeEnv = Env

// ---- native runtime preludes ----
// Some compiled targets reach a capability through a small `<global:X>` runtime shim (a namespace of total functions
// wrapping the platform library: `io`, `math`, `crypto`, `text`). That shim source is NOT in the compiler. It lives in
// the stdlib at `native/<env>/runtime/<X>.<ext>`. This collector is generic: it gathers the `<global:X>` namespaces a
// program docks, and for each one whose runtime file exists it returns that source. The compiler holds the convention
// (where runtime files live, per-target extension), never the content. The build prepends the prelude before emit.

// How far up from a docking module to look for its runtime shim. Four covers `native/<env>/<group>/<module>.tree`
// with room to spare, and stops the walk well short of the filesystem root.
const RUNTIME_SEARCH_DEPTH = 4

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

// A runtime shim may be assembled from shared parts: a line `// runtime-include: <path>` is replaced by that file,
// the path relative to the shim's own directory, itself expanded the same way. So a per-env shim
// (`runtime/compose/native-view.kt`) is the shared Compose runtime plus its platform's host, with no copy of either.
// A part named twice is included once, and a part that cannot be read fails loudly rather than vanishing
const RUNTIME_INCLUDE = /^[ \t]*\/\/[ \t]*runtime-include:[ \t]*(\S+)[ \t]*$/gm

function withIncludes(
  file: string,
  source: string,
  readRuntime: (path: string) => string | undefined,
  seen: Set<string> = new Set([file]),
): string {
  return source.replace(RUNTIME_INCLUDE, (_, relative: string) => {
    const segments = `${directoryOf(file)}/${relative}`.split('/')
    const resolved: string[] = []

    for (const segment of segments) {
      if (segment === '..') {
        resolved.pop()
      } else if (segment !== '.') {
        resolved.push(segment)
      }
    }

    const path = resolved.join('/')

    if (seen.has(path)) {
      return ''
    }

    seen.add(path)
    const part = readRuntime(path)

    if (part === undefined) {
      throw new Error(`runtime ${file} includes ${relative}, which does not exist (${path})`)
    }

    return withIncludes(path, part, readRuntime, seen)
  })
}

// a TypeScript module with its prelude in front, as ONE file. The module declares each global it docks
// (`declare const bit: any`, typescript.ts) so it typechecks on its own; where the prelude in front defines that global,
// the declaration is dropped, or tsc reads two declarations of one name (TS2451) and the file `term make --emit node`
// writes does not typecheck. esbuild never minded, since a `declare` erases. Found by the idiom gate on the first
// program to raise an exception, whose code docks `bit` and `octets` (2026-10-05)
export function joinTypeScriptPrelude(prelude: string, typescript: string): string {
  const defined = new Set([...prelude.matchAll(/^(?:export )?(?:const|let|var|function|class) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1]!))
  const kept = typescript.replace(/^declare const ([A-Za-z_$][\w$]*): any\n/gm, (line, name: string) => (defined.has(name) ? '' : line))

  return `${prelude}\n${kept}`
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
  const docks = globalDocks(program)
  const taken = new Set<number>()
  // what names a dock as used: the emitted code, and every shim taken so far. A shim may call another shim the program
  // never names (the Swift location runtime reads its grant through `nativePermission`, every watcher fans out through
  // `nativeWatch`), and testing the emitted code alone dropped that one: an app that read its position and asked for no
  // permission failed to build with `cannot find 'nativePermission' in scope`. So the docks are taken to a fixpoint
  let reach = usedIn
  let grew = true

  while (grew) {
    grew = false

    for (const [index, { name, alias, file }] of docks.entries()) {
      if (taken.has(index)) {
        continue
      }

      // Skip a dock whose namespace is unreferenced in the emitted code (keeps unused native deps out of the
      // bundle). TESTED AGAINST THE ALIAS, not the global: the alias is the identifier the emitted code actually
      // holds. Testing the global drops the shim of any dock that was renamed, the bundle builds clean, and the
      // first call dies with `ReferenceError: <alias> is not defined`.
      //
      // The alias is spelled in the emitted code the way that backend spells an identifier (`walk-file` is
      // `walkFile` on swift and kotlin, `walk_file` on rust), so all three spellings are tried.
      if (reach !== undefined && !mentions(reach, alias)) {
        continue
      }

      taken.add(index)
      grew = true

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
          // the env's OWN shim first, `runtime/<env>/<name>`: one module with a runtime per platform that shares an
          // extension (the toolkit dom's `native-view.kt` is Android's views, `runtime/compose/native-view.kt`
          // Compose's), then the shim every env of the extension shares
          candidates.push(
            `${dir}/runtime/${env}/${name}.${runtimeExtension(env)}`,
            `${dir}/runtime/${name}.${runtimeExtension(env)}`,
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
      // Each env of the chain is tried in turn (`envChain`): a platform env with no runtime dir of its own (`android`,
      // `compose`) reaches its language's, `native/kotlin/runtime`, rather than missing the shim
      if (file) {
        const at = file.lastIndexOf('/code/')

        if (at >= 0) {
          for (const rung of envChain(env)) {
            candidates.push(`${file.slice(0, at)}/code/native/${rung}/runtime/${name}.${runtimeExtension(env)}`)
          }
        }
      }

      // the stdlib's runtime dir for the env, by path: a global the stdlib provides for an env (`bridge` in `webview`)
      // is for every package that docks it, and a dock in another package (`@term/site`'s db shim, `@term/cask`'s own)
      // never walks up into the stdlib. Without this the bundle built clean and the first call died with
      // `ReferenceError: bridge is not defined`. The env's chain, as above
      const stdlib = stdlibBase()

      if (stdlib) {
        for (const rung of envChain(env)) {
          candidates.push(`${stdlib}/code/native/${rung}/runtime/${name}.${runtimeExtension(env)}`)
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
          const included = withIncludes(candidate, source, readRuntime)
          parts.push(included)
          reach = reach === undefined ? undefined : `${reach}\n${included}`
          break
        }
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

// wrap a resolver so that abstract native imports resolve to the chosen platform's implementation. The env-specific
// module is preferred; then a sibling-env fallback (cloudflare -> browser); then the original path (so a not-yet-ported
// module still resolves).
export function withNativeEnv(
  env: NativeEnv,
  base: Resolver,
): Resolver {
  // `how` (a `base <dir>` under the load) passes through untouched: each rung of the env chain is a whole path,
  // resolved by the package path rule (code root, then package root) the way an explicit path is
  return (importPath: string, fromFile: string, how?: LoadHow): Source | undefined => {
    // the explicit spelling: `load .../native/{platform}/<name>` says on its face that the path is chosen by the
    // target. The env fills the slot; an env with no impl of its own borrows its sibling's (cloudflare -> browser)
    if (importPath.includes('{platform}')) {
      for (const candidate of envChain(env)) {
        const resolved = base(
          importPath.replaceAll('{platform}', candidate),
          fromFile,
          how,
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
        how,
      )
    }

    // the implicit rewrite (`.../native/<name>` -> `.../native/<env>/<name>`) is RETIRED (stdlib-parity-0002):
    // every public stdlib module now spells `native/{platform}/<name>` explicitly, so an abstract path resolves
    // as written or not at all
    return base(importPath, fromFile, how)
  }
}
