// THE PORT SWITCH, the build half (note/term/self-host/04-the-port-switch.md, self-hosting-0018).
//
// A toolchain module ported to Term lives at `deck/<d>/code/<path>.tree`, and its TypeScript original is DELETED in
// the same change. The TypeScript that still imports `@term/<d>/code/<path>` then resolves through the second
// `paths` candidate in tsconfig.json (`./deck/<d>/host/port/*`) to the module this script writes. tsc, tsx and esbuild all
// read those paths, so nothing else has to know a module moved.
//
// WHY NOT `term make`. `term make` writes a module's TypeScript and nothing else, and a module that docks a native
// shim (`bit`, `clock`) then names a global nobody defines: `declare const bit: any`, and the first call is a
// ReferenceError. `term boot` prepends those shims for an app. A ported toolchain module is a LIBRARY imported by
// TypeScript, so it needs the same prelude written into the module itself, which is what makes it a drop-in. Doing
// that in `term make` would change every package's output, including emitted grammars other projects compile under
// `tsc --strict`, so it lives here, where only the toolchain's own ports go through it.
//
// It runs before the CLI is bundled (`pnpm run make:line`), so `host/line.js` always carries the current ports. A
// module is written only when its content changed.
//
//   npx tsx task/port-build.ts            build every port, report what changed
//   npx tsx task/port-build.ts --check    write nothing, exit 1 if any port's output is missing or stale
//   npx tsx task/port-build.ts --only dev/hmr    only the ports whose path holds the text, for a fast port loop

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf } from '@term/call/code/role-of'

// run from the Term package root, the way every script under task/ is
const TERM = process.cwd()

// the toolchain LIBRARIES whose ports TypeScript imports, each with the code subtrees it ports. Of `@term/call` only
// `code/work/item` is a library, the terminal output standard every command prints through (note/term/output/): the
// rest of its .tree is the console (`line/base.tree`) and its verbs, which `term boot` builds as a program and
// nothing imports as a library.
const DECKS: Record<string, string[]> = {
  make: ['code'],
  deck: ['code'],
  flow: ['code'],
  scan: ['code'],
  test: ['code'],
  call: ['code/work/item'],
}

const check = process.argv.includes('--check')
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.endsWith('-cache')) {
      continue
    }

    const full = join(dir, name)
    const stat = lstatSync(full)

    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      trees(full, out)
    } else if (name.endsWith('.tree') && name !== 'draft.tree') {
      out.push(full)
    }
  }
}

function main(): void {
  let built = 0
  let unchanged = 0
  let stale = 0
  let failed = 0

  for (const [deck, subtrees] of Object.entries(DECKS)) {
    const root = join(TERM, 'deck', deck)
    const files: string[] = []

    for (const subtree of subtrees) {
      trees(join(root, subtree), files)
    }

    if (files.length === 0) {
      continue
    }

    const resolve = projectResolver(root)
    const leanOf = projectLeanOf(root)

    for (const file of files) {
      if (only !== undefined && !relative(TERM, file).includes(only)) {
        continue
      }

      const text = readFileSync(file, 'utf8')

      // `mark draft` (or the old `note draft`) shelves a file out of every build, this one included
      if (/^(mark|note) draft\s*$/m.test(text.slice(0, 2000))) {
        continue
      }

      const result = compile({ file, text }, { resolve, leanOf })
      const name = relative(TERM, file)

      if (!result.ok) {
        failed++
        console.log(`  FAIL  ${name}`)

        for (const d of result.diagnostics.slice(0, 3)) {
          console.log(`        ${d.name}: ${d.message}`)
        }

        continue
      }

      const prelude = nativePrelude(result.program, 'node', path =>
        existsSync(path) ? readFileSync(path, 'utf8') : undefined,
      )
      const content = `${prelude ? `${prelude}\n` : ''}${result.typescript}`
      // under `host/port/`, never `host/` itself: `term make` writes `host/<path>.ts` WITHOUT the prelude, and two
      // writers on one path left whichever ran last (found the same hour: the port worked, then a `term make` of
      // the compiler package overwrote it and the next import threw `bit is not defined`)
      const outPath = join(root, 'host', 'port', relative(root, file).replace(/\.tree$/, '.ts'))
      const existing = existsSync(outPath) ? readFileSync(outPath, 'utf8') : undefined

      if (existing === content) {
        unchanged++
        continue
      }

      if (check) {
        stale++
        console.log(`  STALE ${name}`)
        continue
      }

      mkdirSync(join(outPath, '..'), { recursive: true })
      writeFileSync(outPath, content)
      built++
      console.log(`  built ${relative(TERM, outPath)}`)
    }
  }

  console.log(
    `term port-build: ${built} built, ${unchanged} unchanged${check ? `, ${stale} stale` : ''}, ${failed} failed`,
  )

  if (failed > 0 || stale > 0) {
    process.exitCode = 1
  }
}

main()
