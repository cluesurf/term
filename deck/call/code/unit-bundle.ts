// A program built one unit at a time, written out for a bundler (note/term/plan/incremental-best-in-class.md, steps 9
// and 10). `term boot` and `term test` both hand esbuild a program made of units: every module of the closure beside
// one another under `host/.unit/`, an entry that re-exports every public task of the closure (call/code/make.ts
// `entryShim`), and the native prelude as a module of its own.
//
// THE PRELUDE IS A MODULE, AND EACH MODULE IMPORTS THE SHIMS IT DOCKS. The merged build put the prelude in front of
// the one module it emitted, so a shim's names were that module's and no one else's. In front of a bundle of many
// modules, as a banner, the bundler could not see them: the path shim imports `isAbsolute` from `node:path`, the
// standard library's path module declares a task `isAbsolute`, and the bundle failed to load with `Identifier
// 'isAbsolute' has already been declared`. Put on `globalThis` instead, the `crypto` shim met Node's own `crypto`,
// which cannot be assigned, and would have replaced it for every other package if it could. So the prelude is a
// module that exports each shim's namespace, and a module that docks one, which its emit says with `declare const
// <name>: any`, imports it from there instead: each shim reaches exactly the modules that dock it, as before.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import { entryShim } from '@term/call/code/make'
import { toCamel } from '@term/make/code/compile/typescript'

// a module's own word that it docks a native namespace
const DOCKED = /^declare const ([A-Za-z_$][\w$]*): any$/gm

// writes the program under `dir` and answers the file to hand the bundler
export function writeUnitBundle(input: {
  dir: string
  // the module the program starts from, and every module of its closure with the name its siblings import it by
  entry: string
  modules: [string, ModuleEmit][]
  slug: (file: string) => string
  exports: { name: string; exported: string; file: string; type: boolean }[]
  // the shims the program docks (compile/native.ts `nativePrelude`)
  prelude: string
  // names the run calls that the entry neither defines nor imports: a command table's tasks (`runtimeExports`)
  keep?: string[]
}): string {
  const host = path.join(input.dir, 'host')
  mkdirSync(path.join(host, '.unit'), { recursive: true })

  // the namespaces the modules dock, and of those the ones a shim defines
  const docked = new Set(input.modules.flatMap(([, emit]) => [...emit.code.matchAll(DOCKED)].map(found => found[1]!)))
  const offered = new Set([...docked].filter(name => definesAtTop(input.prelude, name)))

  for (const [file, emit] of input.modules) {
    const code = emit.code.replace(DOCKED, (line, name: string) => (offered.has(name) ? `import { ${name} } from '../prelude'` : line))
    writeFileSync(path.join(host, '.unit', `${input.slug(file)}.ts`), code)
  }

  writeFileSync(path.join(host, 'prelude.ts'), `${input.prelude}\n;\nexport { ${[...offered].join(', ')} }\n`)

  const app = path.join(host, 'app.ts')
  const entryCode = input.modules.find(([file]) => file === input.entry)?.[1].code ?? ''
  writeFileSync(app, entryShim(input.dir, path.join(input.dir, 'app.tree'), runtimeExports(input.entry, entryCode, input.exports, input.keep), input.slug))

  return app
}

// the names the program's run reaches it by, which are all the bundler may keep: the entry's own (its tests, a server's
// `boot`), every name the entry imports (a command's task is often another file's: zone's `call`, `show`, `moor`), and
// the hive's wake wherever it is defined. THE BUNDLE IS SHAKEN BY ITS ENTRY: esbuild keeps every export of the module it
// starts from, and this entry re-exported the whole closure, so a command that trims one text shipped every task of the
// text module (19 of 20 functions unused, tmp/shake-probe.sh, 2026-10-05). The artifact `term make` writes under host/
// keeps the whole closure: a TypeScript importer reads any name off it
const RUNTIME_NAMES = new Set(['wake-hive', 'boot', 'start', 'main'])

export function runtimeExports<T extends { name: string; file: string }>(
  entry: string,
  entryCode: string,
  exports: T[],
  keep: string[] = [],
): T[] {
  const kept = new Set(keep)

  // the local names of the entry module's value imports, as compile/modules.ts writes them: `import { a, b as c } from`
  const imported = new Set(
    [...entryCode.matchAll(/^import \{ ([^}]*) \} from /gm)].flatMap(found =>
      found[1]!.split(',').map(part => part.trim().split(/\s+as\s+/).pop()!),
    ),
  )

  return exports.filter(
    one => one.file === entry || RUNTIME_NAMES.has(one.name) || kept.has(one.name) || imported.has(toCamel(one.name)),
  )
}

// whether the prelude binds `name` at its top level, as a shim binds its namespace (`const path = { ... }`)
function definesAtTop(prelude: string, name: string): boolean {
  return new RegExp(`(^|[;\\n])\\s*(export\\s+)?(const|let|var|class|(async\\s+)?function\\*?)\\s+${name.replace(/\$/g, '\\$')}\\b`).test(prelude)
}
