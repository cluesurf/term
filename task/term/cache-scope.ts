// WHICH COMPILER SOURCES CAN AFFECT WHICH CACHE KIND, derived from the real import graph.
//
// The build cache is versioned by a fingerprint of the compiler, so a compiler change never serves a stale hit.
// That fingerprint used to be ONE hash over all 220 `.ts` files in `deck/make/code` and `deck/call/code`, which is
// correct and far too coarse: a one-line change to the Swift emitter opened a new namespace for every kind, every
// env and every project, and stranded the lot.
//
// Measured 2026-09-02 on this laptop, mid-session, after a day of compiler work:
//
//   total 143 MB: 396 B live, 143 MB stale
//
// Every cache in the tree, dead. The comment in cache-store.ts already priced what that costs: `@term/bind` is
// 3,091 files at 165 ms each to compile and 2.1 ms each to serve from cache, so a build that cannot read its own
// cache pays 78x per file.
//
// The fix is to fingerprint each kind against only the code that can reach it:
//
//   mill     11 files    parse, template expansion, mill
//   output   59 files    the front end plus the TypeScript emitter
//
// against 220 today. The non-node emitters (rust, swift, kotlin, hvm, wgsl) are in NEITHER: they are exported and
// called from test harnesses and the native gate, never from the compile path, so a change to one cannot change a
// cached entry and must not invalidate one.
//
// THE LISTS ARE GENERATED, NEVER HAND-WRITTEN. A hand-written list is a second implementation of the import graph
// and disagrees with it the first time somebody adds an import. This walks the graph and writes the answer:
//
//   pnpm term:cache-scope           check that the committed lists match the graph (a gate; exits non-zero)
//   pnpm term:cache-scope --write   regenerate them after an import changes
//
// UNDER-COUNTING IS THE DANGEROUS DIRECTION. A file that can affect an entry but is left out of its kind means a
// STALE HIT: the compiler changes and the cache serves the old answer. So the gate fails closed, and the entry
// points below are deliberately the widest true ones.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT } from './root'

const ROOT = TERM_ROOT
const TERM = TERM_ROOT
// a Term data module (decision 028 point 4: a generated file is generated Term, never TypeScript). Its port is
// deck/make/host/port/code/compile/cache-scope.ts, which the walk below reaches like any port's
const GENERATED = join(TERM, 'deck/make/code/compile/cache-scope.tree')

// The entry module of each cache kind: the function whose result the entry holds.
//
//   mill    `mill()` turns a parsed tree into a typed program, and `parse` and `expandTemplates` run before it. The
//           module walk's import scan (`scanImports` in `load.ts`) is stored under this kind too
//           (`CompileCache.scanned`), so its scanner is an entry as well.
//   output  `compile()` is the whole pipeline, and the entry holds its result.
//   unit    `compileSeparate()` answers one unit at a time, and the entry holds one unit's build: its modules, its
//           stubs, its surface. Kept machine-wide, as the mill is, since a unit's key names its content and what it
//           reaches, never which project asked (note/project/term/incremental-best-in-class.md, step 1).
//
// Everything reachable from these by import can change what the entry contains. Nothing else can.
const KIND_ENTRIES: Record<string, string[]> = {
  // `parse` is not listed: the parser is a port (parser/tree.tree), and load.ts's import of it brings in its source
  // and its emitted module like any port's. Its old `parser/tree.ts` stood here after the file was gone, which put a
  // path no build reads into the mill scope and outside the output scope (`cache hit` caught it, 2026-10-06)
  mill: [
    'deck/make/code/compile/mill.ts',
    'deck/make/code/compile/template.ts',
    'deck/make/code/compile/load.ts',
  ],
  output: ['deck/make/code/compile/compile.ts'],
  unit: ['deck/make/code/compile/separate.ts'],
}

// The entry ENCODING, which is not reachable from either entry point and can still change what a stored entry
// means: the gzip, the shard layout, the version directory, the JSON shape. Belongs to every kind.
const ALWAYS = ['deck/call/code/cache-store.ts', 'deck/make/code/compile/cache.ts']

function resolveImport(spec: string, from: string): string | undefined {
  let base: string

  if (spec.startsWith('@term/make/')) {
    base = join(TERM, 'deck/make', spec.slice('@term/make/'.length))
  } else if (spec.startsWith('@term/call/')) {
    base = join(TERM, 'deck/call', spec.slice('@term/call/'.length))
  } else if (spec.startsWith('.')) {
    base = resolve(dirname(from), spec)
  } else {
    // a package outside the compiler (node builtins, npm). Its version is pinned by the lockfile, not by us.
    return undefined
  }

  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

// A MODULE PORTED TO TERM is part of the compiler too. Its `.ts` is gone (`check/arm.ts` became `check/arm.tree`,
// note/project/term/self-host/04-the-port-switch.md), so the walk above finds nothing and the scope silently LOST it: an
// edit to `arm.tree` would then invalidate no cache entry, and the entry would serve a stale answer, the exact failure
// this gate exists for. So a port contributes its source AND its emitted module (which also changes when anything it
// inlines from the stdlib changes). Both are hashed by the cache store like any listed file.
//
// THE EMITTED MODULE IS WALKED TOO. The port build inlines a port's `.tree` closure, but every `dock load` in that
// closure stays a TypeScript import of the emitted module: unit-mill.tree docks compile/mill.ts, and minting.tree docks
// the baked mill grammar (compile/mill-grammar.tree's port). Not walking them left the whole mill (mill.ts, mill-run.ts,
// mint-bridge.ts, the minting ports and the code role's grammar text) outside the output scope, so a mill change moved
// the mill kind's version and not output's, and an output entry built by the old mill could be served (item
// term-self-host-001-0343, `cache hit` check 8).
function portOf(spec: string, from: string): string[] {
  let pkg: string | undefined
  let rest: string | undefined

  for (const name of ['make', 'call']) {
    if (spec.startsWith(`@term/${name}/`)) {
      pkg = name
      rest = spec.slice(`@term/${name}/`.length)
    }
  }

  if (!pkg && spec.startsWith('.')) {
    const at = relative(TERM, resolve(dirname(from), spec))
    const match = /^deck\/(make|call)\/(.+)$/.exec(at)
    pkg = match?.[1]
    rest = match?.[2]
  }

  if (!pkg || !rest) {
    return []
  }

  const source = join(TERM, 'deck', pkg, `${rest}.tree`)

  if (!existsSync(source)) {
    return []
  }

  const emitted = join(TERM, 'deck', pkg, 'host/port', `${rest}.ts`)

  return existsSync(emitted) ? [source, emitted] : [source]
}

// every compiler file reachable from `entries`, as repository-relative paths
function closureOf(entries: string[]): string[] {
  const seen = new Set<string>()

  const walk = (file: string): void => {
    if (seen.has(file)) {
      return
    }

    seen.add(file)

    let text: string

    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }

    // `from '...'` covers static imports and re-exports; `import('...')` covers a dynamic one
    for (const found of text.matchAll(
      /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
    )) {
      const next = resolveImport(found[1]!, file)

      if (next) {
        walk(next)
      } else {
        // the source is hashed as it stands; the emitted module is walked, so its docks' TypeScript joins the scope
        for (const port of portOf(found[1]!, file)) {
          if (port.endsWith('.ts')) {
            walk(port)
          } else {
            seen.add(port)
          }
        }
      }
    }
  }

  for (const entry of entries) {
    // an entry is hand-written, so one that names no file is a stale list, and walking it would record the path anyway
    if (!existsSync(join(TERM, entry))) {
      throw new Error(`cache scope entry ${entry} names no file: a module that was ported or moved is reached by import`)
    }

    walk(join(TERM, entry))
  }

  return [...seen].map(file => relative(TERM, file)).sort()
}

// a path as the content of a Term text literal: every character the literal reads as syntax escaped
function escaped(text: string): string {
  return text.replace(/[\\<>{}]/g, character => `\\${character}`)
}

// The scope as a Term data module: one private task per kind answering its files, and `cache-scope` answering the hash
// of them, kinds in the order the walk wrote them. A kind is a lower-case word (KIND_ENTRIES), so it names its task
export function render(scope: Record<string, string[]>): string {
  const out = [
    '# GENERATED by task/term/cache-scope.ts. Never edit this file: run `pnpm term:cache-scope --write`.',
    '#',
    '# The compiler files that can affect each cache kind, walked from the import graph. The build cache fingerprints a',
    '# kind against ONLY these, so a change to code no cache entry can reach does not strand the cache. See the header',
    '# of task/term/cache-scope.ts for why, and for what the coarse fingerprint cost.',
    '#',
    '# `pnpm term:cache-scope` fails when this disagrees with the graph, which is what stops it rotting into a second,',
    '# wrong implementation of the same question.',
    '',
    'load @term/base/list',
    '  find list',
    '',
    '# the files of each kind, by kind, in the order the walk wrote them',
    'task cache-scope',
    '  like hash, like text, like list, like text',
    '',
    '  save scope, like hash, like text, like list, like text',
    '    make hash',
  ]

  for (const kind of Object.keys(scope)) {
    if (!/^[a-z]+$/.test(kind)) {
      throw new Error(`cache scope kind ${kind} is not a lower-case word, so it cannot name its task`)
    }

    out.push(`  save ${kind}-kind, <${kind}>`, `  save scope/{${kind}-kind}, ${kind}-files()`)
  }

  out.push('  back scope', '')

  for (const [kind, files] of Object.entries(scope)) {
    out.push(
      `task ${kind}-files`,
      '  like list, like text',
      '  mark private',
      '',
      '  save files, like list, like text',
      '    make list',
      ...files.map(file => `  push(files, <${escaped(file)}>)`),
      '  back files',
      '',
    )
  }

  return out.join('\n')
}

function main(): void {
  const write = process.argv.includes('--write')
  const scope: Record<string, string[]> = {}

  for (const [kind, entries] of Object.entries(KIND_ENTRIES)) {
    scope[kind] = closureOf([...entries, ...ALWAYS])
  }

  const wanted = render(scope)

  for (const [kind, files] of Object.entries(scope)) {
    console.log(`  ${kind.padEnd(8)} ${String(files.length).padStart(4)} files`)
  }

  if (write) {
    writeFileSync(GENERATED, wanted)
    console.log(`\nterm cache-scope: wrote ${relative(ROOT, GENERATED)}`)

    return
  }

  const have = existsSync(GENERATED) ? readFileSync(GENERATED, 'utf8') : ''

  if (have !== wanted) {
    console.log(
      `\nterm cache-scope: ${relative(ROOT, GENERATED)} is out of date with the import graph.`,
    )
    console.log(
      '  An import changed and the cache scope did not follow. A kind that is missing a file it can reach serves',
    )
    console.log(
      '  a STALE HIT after that file changes, which is the failure this gate exists to prevent.',
    )
    console.log('  Re-run: pnpm term:cache-scope --write')
    process.exitCode = 1

    return
  }

  console.log('\nterm cache-scope: the committed scope matches the import graph')
}

// run as a command, never on import (the pair imports render)
if (process.argv[1]?.endsWith('cache-scope.ts')) {
  main()
}
