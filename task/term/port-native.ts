// Every file ported from TypeScript into Term still compiles on every backend.
//
// `pnpm term:self-host` asks whether a port ANSWERS the same thing as the TypeScript it replaces. That is the rung-1
// question and it is answered on node, because both sides are node programs there. It cannot see the other half of
// why the port exists: the whole point of writing the toolchain in Term is a NATIVE binary, so a port that agrees
// perfectly on node and does not reach Rust has bought nothing.
//
// Those two failures look nothing alike. A disagreement is a diff in familiar output. A backend hole is a module that
// compiles clean on node and has no native path at all, and it stays invisible until the day someone tries to build
// the binary and finds it in file 200 of 300.
//
// So this compiles every ported file on every backend and fails when one does not. It is cheap now (one file) and it
// is exactly the check that must exist BEFORE the volume arrives, because a gap found at file 200 is a rewrite of
// files 1 to 199.
//
// WHAT COUNTS AS A PORT: a `.tree` under `<package>/code/term/`. That directory is the convention self-hosting-0003
// established for "this was TypeScript in the same package and is now Term", which keeps a port beside the code it
// replaces without pretending to be stdlib.
//
// Run from the repository root: `pnpm term:port-native`. Reports by default and writes nothing.

import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { TERM_ROOT } from './root'

// run from the Term root, the way every other term task is
const TERM = TERM_ROOT
const DECK = join(TERM, 'deck')

const verbose = process.argv.includes('--verbose')
// `--only dev/hmr`: just the ports whose path holds the text, for one turn of the port loop
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined

// node is the baseline the other three are held against, not a fourth opinion
const ALL_BACKENDS = ['node', 'rust', 'swift', 'kotlin']
// `PORT_NATIVE_ONLY=rust`: one backend, the way the gate runs it (task/term/test.ts). One process over all four took
// over 2,400 s at load 15 to 50 and was killed at its suite limit three times with nothing failed (item 0528), so the
// gate runs four suites under its own --jobs, each a quarter of the work under the same limit, and the machine sees no
// more parallelism than the gate already allows. Unset, all four in one process
const onlyBackend = process.env.PORT_NATIVE_ONLY

if (onlyBackend !== undefined && !ALL_BACKENDS.includes(onlyBackend)) {
  throw new Error(`port-native: PORT_NATIVE_ONLY is one of ${ALL_BACKENDS.join(', ')}`)
}

const BACKENDS = onlyBackend === undefined ? ALL_BACKENDS : [onlyBackend]

// THE TOOLCHAIN LIBRARIES, whose every `.tree` is a port: a module ported to Term lives at its own path
// (`check/arm.tree` replaced `check/arm.ts`, note/project/term/self-host/04-the-port-switch.md), the same set
// task/port-build.ts compiles. Every other package counts only what sits under `code/term/`, the convention
// self-hosting-0003 set before ports moved to their real paths.
const LIBRARIES = new Set(['make', 'deck', 'flow', 'scan', 'test'])

function treesUnder(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    if (['node_modules', 'host', '.base', 'tmp', 'link'].includes(name)) {
      continue
    }

    const full = join(dir, name)

    try {
      const stat = lstatSync(full)

      if (stat.isDirectory()) {
        treesUnder(full, out)
      } else if (stat.isFile() && name.endsWith('.tree') && name !== 'draft.tree') {
        out.push(full)
      }
    } catch {
      continue
    }
  }
}

// every port, with the package root it resolves against
function ports(): Array<{ file: string; root: string }> {
  const found: Array<{ file: string; root: string }> = []

  for (const pkg of readdirSync(DECK).sort()) {
    const root = join(DECK, pkg)
    const files: string[] = []

    treesUnder(join(root, LIBRARIES.has(pkg) ? 'code' : 'code/term'), files)

    for (const full of files) {
      if (only !== undefined && !relative(TERM, full).includes(only)) {
        continue
      }

      // `mark draft` (or the old `note draft`) shelves a file out of the build, so it is not evidence about anything
      if (/^(mark|note) draft\s*$/m.test(readFileSync(full, 'utf8').slice(0, 2000))) {
        continue
      }

      found.push({ file: full, root })
    }
  }

  return found
}

function main(): void {
  const list = ports()

  console.log(
    `term port-native: ${list.length} ported file(s) on ${BACKENDS.length} backends`,
  )
  console.log('')

  let bad = 0

  for (const { file, root } of list) {
    const resolve = projectResolver(root)
    const text = readFileSync(file, 'utf8')
    const marks: string[] = []

    for (const env of BACKENDS) {
      let ok = false
      let why = ''

      try {
        // the role and the lean surface: every toolchain port is written lean (@term/make's role.tree)
        const result = compile(
          { file, text },
          { resolve, env, roleOf: projectRoleOf(root), leanOf: projectLeanOf(root) },
        )

        ok = result.ok

        if (!ok) {
          why = (result.diagnostics ?? [])
            .slice(0, 2)
            .map(d => `${d.name}: ${d.message?.slice(0, 70)}`)
            .join(' | ')
        }
      } catch (cause) {
        why = `threw ${String(cause).slice(0, 70)}`
      }

      if (ok) {
        marks.push(`ok ${env}`)
      } else {
        bad++
        marks.push(`FAIL ${env}`)

        if (verbose || why) {
          marks.push(`      ${env}: ${why}`)
        }
      }
    }

    console.log(`  ${relative(TERM, file).padEnd(38)} ${marks.join('  ')}`)
  }

  console.log('')
  console.log(
    `term port-native: ${list.length * BACKENDS.length - bad} pass, ${bad} fail`,
  )

  if (bad > 0) {
    process.exitCode = 1
  }
}

main()
