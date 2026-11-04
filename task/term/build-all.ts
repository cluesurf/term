// Every Term package, built with `term make`.
//
// WHY THIS EXISTS. `pnpm term:test` runs test SUITES. A package whose .tree files do not compile at all has no
// suite to fail, so on 2026-08-30 the board read 222 pass / 0 fail while four packages did not build. That is
// the exact failure mode the workflow rules name: "no check fires on it" is not "someone verified it".
//
// A package is skipped only with a NAMED reason, never silently:
//   - `mill` holds mill GRAMMAR files (mine.tree / mint.tree), which are dialect definitions rather than
//     ordinary Term code. `term make` is not what checks them; `pnpm term:mill-forms`
//     (test/compile/mill-grammar.ts) is, and it passes.
//   - a package whose package.json carries a `make` script has `term make` run THAT SCRIPT instead of compiling
//     .tree at all. That script's build is its own business, but its .tree files are not: they were a blind spot
//     for four packages (base, deck, mill, seed) holding 1,138 .tree files between them. Such a package is checked
//     by compiling its .tree files directly, alongside whatever its script does.
//
// Run: pnpm term:build-all            (report; exits non-zero if any package regressed)
//      pnpm term:build-all --list     (just name the packages and their state)

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TERM_ROOT } from './root'

const TERM = TERM_ROOT
const DECK = join(TERM, 'deck')
const LINE = join(TERM, 'host/line.js')
// Every @term/* package lives in deck/<name>. @term/bind used to sit a level up as
// `deck/term/deck/bind.tree`, a sibling of the term package, and was named here as a special case. It moved in on
// 2026-08-30 (19M of package; its 374M of generator inputs stayed behind), so the special case is gone and bind is
// found by the ordinary walk like everything else.

// Packages known not to build today, with the reason and the project that owns fixing it. This list is a
// BASELINE, not permission: the check fails if a package outside it breaks, and it fails if a package on it
// starts working (so the list cannot rot into a place things are hidden).
// EMPTY, and it should stay that way. Both entries were cleared on 2026-08-30:
//
//   face  40 errors -> 0. Most were one compiler bug: deck/make/code/compile/load.ts discovered a module's imports
//         with a hand-rolled line scan that counted the `<` and `>` on COMMENT lines toward text-literal balance, so
//         one bare `<` in an English sentence ("cell < row < list/selection") left the depth stuck at 1, every
//         column-0 line after it read as literal content, and the file's `load` directives vanished. The scan is
//         gone; the real parser reads the imports now. The last one was a package-global name collision: @term/bind
//         and @term/site's node DOM both defined `form element`, so `read x/parent` reached the wrong one.
//   site  9 errors -> 0. A `deck.tree` MANIFEST was being compiled as code, and the build walk descended into the
//         blog sample app (its own package, `deck @term/blog`) and resolved its `@term/site` imports against the
//         wrong root. Neither is the walk's business. The rest were an example written against a lifecycle hook
//         that never existed (`hook mount-start`, now `call on-mount`) and a parameter named `get` for `source`.
//
// A package that breaks fails this check, and a package added here fails it too once it starts working, so the list
// cannot rot into a place things are hidden.
const KNOWN: Record<string, string> = {}

// skipped, with the reason, the way the gate skips a toolchain suite
const SKIP: Record<string, string> = {
  mill: 'holds mill grammar files, checked by pnpm term:mill-forms instead',
}

type Package = { name: string; dir: string }

function packages(): Package[] {
  const inner = readdirSync(DECK)
    .filter(name => existsSync(join(DECK, name, 'deck.tree')))
    .map(name => ({ name, dir: join(DECK, name) }))
  return inner.sort((a, b) => a.name.localeCompare(b.name))
}

function hasMakeScript(dir: string): boolean {
  const file = join(dir, 'package.json')

  if (!existsSync(file)) {
    return false
  }

  try {
    return Boolean((JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> }).scripts?.make)
  } catch {
    return false
  }
}

function builds(dir: string): { ok: boolean; note: string } {
  try {
    // the buffer is the warnings' room: @term/bind prints one per undeclared host type (45,677 on 2026-10-03), which
    // overran the default 1 MB, threw, and was reported as a broken build quoting the first warning
    const out = execFileSync('node', [LINE, 'make'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    })

    if (/failed/.test(out)) {
      return { ok: false, note: (out.split('\n').find(l => /failed/.test(l)) ?? '').trim() }
    }

    return { ok: true, note: (out.split('\n').find(l => /Compiled/.test(l)) ?? '').trim() }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`

    return { ok: false, note: (text.split('\n').find(l => /failed|error/i.test(l)) ?? 'build failed').trim() }
  }
}

// compile a package's .tree files directly, bypassing the package.json `make` script that `term make` defers to.
// Imported rather than shelled out to: this script is already tsx, and a child process would pay the compiler's
// startup for each package.
function buildsTrees(dir: string): { ok: boolean; note: string } {
  try {
    const out = execFileSync('node', [LINE, 'make', '--trees'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })

    if (/failed/.test(out)) {
      return { ok: false, note: (out.split('\n').find(l => /failed/.test(l)) ?? '').trim() }
    }

    // `files?`, because one file prints "Compiled 1 file" and the plural-only pattern read that as zero. A count
    // that under-reports is the dangerous direction: a package whose .tree files stopped being FOUND reports zero
    // too, and the two are indistinguishable in the summary line.
    const compiled = /Compiled (\d+) files?/.exec(out)?.[1] ?? '0'

    return { ok: true, note: `own \`make\` script builds its TypeScript; ${compiled} .tree file${compiled === '1' ? '' : 's'} compile` }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`

    return { ok: false, note: (text.split('\n').find(l => /failed|error/i.test(l)) ?? 'tree build failed').trim() }
  }
}

const listOnly = process.argv.includes('--list')
// `--only <package>`: one package, which is how `pnpm term:test` runs this, one suite per package, so the packages
// build side by side in its pool instead of one after another in a single suite (that suite was 1,157 seconds of
// wall clock on 2026-10-02, the longest in the gate by three times)
const onlyArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
let broke = 0
let fixed = 0
let ok = 0

for (const { name, dir } of packages().filter(p => onlyArg === undefined || p.name === onlyArg)) {
  const skip = SKIP[name]

  if (skip) {
    console.log(`skip  ${name.padEnd(6)} ${skip}`)
    continue
  }

  if (listOnly) {
    console.log(`      ${name.padEnd(6)} ${KNOWN[name] ? 'known broken' : 'expected to build'}`)
    continue
  }

  // a package whose package.json owns `make` still has its .tree compiled here, directly, because `term make` would
  // run the script and compile none of it
  const result = hasMakeScript(dir) ? buildsTrees(dir) : builds(dir)
  const known = KNOWN[name]

  if (result.ok && known) {
    fixed++
    console.log(`FIXED ${name.padEnd(6)} builds now, so take it off the KNOWN list in this file`)
  } else if (result.ok) {
    ok++
    console.log(`ok    ${name.padEnd(6)} ${result.note}`)
  } else if (known) {
    console.log(`known ${name.padEnd(6)} ${known}`)
  } else {
    broke++
    console.log(`BROKE ${name.padEnd(6)} ${result.note}`)
  }
}

if (!listOnly) {
  console.log(
    `\nterm build-all: ${ok} build, ${onlyArg === undefined ? Object.keys(KNOWN).length : KNOWN[onlyArg] ? 1 : 0} known broken, ${broke} newly broken, ${fixed} newly fixed`,
  )
}

if (broke > 0 || fixed > 0) {
  process.exit(1)
}
