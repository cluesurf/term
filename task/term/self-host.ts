// Rung 1 of the bootstrap: does the compiler written in Term answer exactly what the compiler written in
// TypeScript answers?
//
// Self-hosting has a ladder and this is its first rung (note/project/term/self-host/archive/self-hosting.md). The compiler is ported
// to `.tree` one piece at a time, each piece compiled BY today's compiler into TypeScript, and each piece held
// against the hand-written TypeScript it replaces. Only when the whole thing agrees does it make sense to emit
// Rust and build a binary. Going straight to Rust is tempting because a binary is the goal, and it is the wrong
// order: a mistranslation shows up here as a diff in familiar output, and there as a segfault in generated code.
//
// THE INPUTS ARE THE REAL CORPUS, NOT FIXTURES. Every `.tree` file in every package is parsed with the compiler's
// own parser and every NAME in it is collected, so `to-camel` is checked against the thousands of identifiers the
// compiler actually emits rather than against a dozen a person thought of. A fixture tests what its author
// imagined; a corpus tests what the codebase contains, and the difference is where ports break.
//
// IT IS DRY BY CONSTRUCTION. A pairing is one entry in `PAIRS` below: the name, the TypeScript function, the Term
// function, and where the inputs come from. Porting another piece of the compiler means adding one entry, not
// writing another test. The corpus is gathered once and shared by every pairing that wants the same kind of input.
//
// Run from the repository root: `pnpm term:self-host`. Reports by default and writes nothing.
//
//   pnpm term:self-host --verbose     every difference, not the first ten
//   pnpm term:self-host --limit 200   cap the corpus, for a fast loop

import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import { installShims } from './pair/load'
import { parse } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/narrow'
import { renderHead } from '@term/make/code/parser/tree'
import { TERM_ROOT } from './root'

// run from the Term root, the way every other term task is
const TERM = TERM_ROOT
const DECK = join(TERM, 'deck')
// the base record system, deck/save. Its glob is still held against its Term
// port, which `term make` builds into its host/.
const SAVE = (): string => join(DECK, 'save')

const verbose = process.argv.includes('--verbose')
const limitArg = process.argv.find(a => a.startsWith('--limit'))
const LIMIT = limitArg
  ? Number(limitArg.split('=')[1] ?? process.argv[process.argv.indexOf(limitArg) + 1])
  : 0

// ---- the prelude ----
//
// `installShims` (the native shims a port's emitted module assumes are global) moved to task/term/pair/load.ts
// with the pair runner, so there is one version of it.

// ---- the corpus ----

// every `.tree` file in every package, honouring the two shelving markers the build walk honours, so a deliberately
// unfinished module is not evidence about anything
function treeFiles(): string[] {
  const found: string[] = []

  const walk = (at: string): void => {
    if (existsSync(join(at, 'draft.tree'))) {
      return
    }

    let names: string[]

    try {
      names = readdirSync(at).sort()
    } catch {
      return
    }

    for (const name of names) {
      if (name === 'host' || name === 'link' || name === 'node_modules' || name === '.base') {
        continue
      }

      const full = join(at, name)

      try {
        if (lstatSync(full).isSymbolicLink()) {
          continue
        }

        if (lstatSync(full).isDirectory()) {
          walk(full)
          continue
        }
      } catch {
        continue
      }

      if (name.endsWith('.tree')) {
        found.push(full)
      }
    }
  }

  for (const pkg of readdirSync(DECK).sort()) {
    const code = join(DECK, pkg, 'code')

    if (existsSync(code)) {
      walk(code)
    }
  }

  return found
}

// Every NAME in the corpus, through the compiler's own parser.
//
// THE PARSER, NEVER A REGEX. There is one reader for `.tree` in this codebase (note/project/term/one-parser.md), and a
// gate that scraped identifiers with a pattern would be a second one -- it would disagree with the compiler about
// what a name is, which is the exact class of bug this whole project exists to remove.
function namesInCorpus(): string[] {
  const names = new Set<string>()

  const visit = (node: Node): void => {
    if (node.kind === 'name') {
      const text = renderHead(node)

      // an interpolated name (`native/{platform}/path`) is not an identifier the emitter will see
      if (text && !text.includes('{')) {
        for (const part of text.split('/')) {
          if (/^[a-z][a-z0-9-]*$/.test(part) || /^[a-z][a-z0-9_]*$/.test(part)) {
            names.add(part)
          }
        }
      }

      return
    }

    if (node.kind === 'group') {
      for (const kid of node.nodes) {
        visit(kid)
      }
    }
  }

  for (const file of treeFiles()) {
    let tree: RootNode

    try {
      const parsed = parse({ file, text: readFileSync(file, 'utf8') })

      if (!parsed.ok) {
        continue
      }

      tree = parsed.tree
    } catch {
      continue
    }

    for (const node of tree.nodes) {
      visit(node)
    }
  }

  return [...names].sort()
}

// Every glob shape a `role base` config can hold, against every real path in the tree.
//
// The patterns are written out because there is no corpus of them yet -- no committed config uses more than a
// handful -- and the interesting cases are the ones nobody writes until they break: a `**/` that has to match zero
// segments, a `?` next to a `.`, and a pattern carrying regular-expression punctuation (`+`, `$`, `(`) that a glob
// must treat as ordinary text. The PATHS are the real corpus, so each pattern is answered thousands of times.
function globCalls(): Call[] {
  const patterns = [
    '**/*.tree',
    '**/*.ts',
    '*.tree',
    'deck/**',
    'deck/*/code/**',
    'deck/base/code/*.tree',
    '**/native/**/*.tree',
    '**/host/**',
    '?ode/**',
    'deck/????/code/**',
    '**/draft.tree',
    'deck/make/code/parser/tree.ts',
    // regular-expression punctuation a glob must NOT interpret
    'deck/make+code/**',
    'deck/(make)/**',
    'deck/make$/**',
    'deck/[make]/**',
    'a.b/**',
    // the empty-segment case `**/` exists for
    '**/tree.ts',
    '**',
    '**/**/*.tree',
  ]

  const paths = treeFiles().map(file => relative(TERM, file))
  const use = LIMIT > 0 ? paths.slice(0, LIMIT) : paths

  return patterns.flatMap(pattern => use.map(path => [pattern, path]))
}

// ---- the pairings ----

// One call, as a list of arguments, so a pairing over a two-argument function (a glob and a path) is the same
// shape as one over a one-argument function and needs no second harness.
type Call = string[]

type Pair = {
  // what is being compared, as it reads in the report
  name: string
  // the shipped TypeScript
  ts: (...input: Call) => unknown
  // the same thing, written in Term and compiled by today's compiler
  term: (...input: Call) => unknown
  // the inputs, from the real corpus
  inputs: () => Call[]
}

async function pairs(): Promise<Pair[]> {
  installShims(['bit', 'regex'])

  const typescript = (await import(
    join(TERM, 'deck/make/code/compile/typescript.ts')
  )) as {
    toCamel: (name: string) => string
    toConstant: (name: string) => string
  }

  // the module the port build writes (task/port-build.ts), the one the compiler itself imports through the
  // `host/port/*` fallback, never `term make`'s copy under `host/code/`, which nothing rebuilds in step with this
  const term = (await import(
    join(TERM, 'deck/make/host/port/code/term/name.ts')
  )) as {
    toCamel: (name: string) => string
    toConstant: (name: string) => string
  }

  const glob = (await import(
    join(SAVE(), 'code/file/glob.ts')
  )) as { matchesGlob: (pattern: string, path: string) => boolean }

  const termGlob = (await import(
    join(SAVE(), 'host/code/term/glob.ts')
  )) as { matchesGlob: (pattern: string, path: string) => boolean }

  const corpus = namesInCorpus()
  const inputs = () =>
    (LIMIT > 0 ? corpus.slice(0, LIMIT) : corpus).map(one => [one])

  return [
    { name: 'to-camel', ts: typescript.toCamel, term: term.toCamel, inputs },
    // `hash-text` WAS PAIRED HERE until 2026-10-02, when the compiler SWITCHED to the port (self-hosting-0018):
    // the TypeScript original in compile/cache.ts was deleted, so there is no second implementation left to hold
    // the port against. Its oracle is now the one the spec gives every finished port: the same .tree on every
    // backend (`pnpm term:port-native`) and, at the end, the fixpoint. The switch also found the one input class
    // this pairing never sent, text outside the Basic Multilingual Plane, where the two disagreed (UTF-16 units
    // against code points); every name in the corpus is ASCII.
    {
      name: 'to-constant',
      ts: typescript.toConstant,
      term: term.toConstant,
      inputs,
    },
    {
      // THE FIRST `@cluesurf/save` FILE (self-hosting-0003, written when it was `@term/base`). A glob compiles to a regular expression, so a port that
      // is one character off in the escaping answers `true` on a path it should reject, and a rule meant to
      // ignore build output starts ignoring source. Held over every real path in the tree.
      name: 'matches-glob',
      ts: glob.matchesGlob,
      term: termGlob.matchesGlob,
      inputs: globCalls,
    },
  ]
}

function main(list: Pair[]): void {
  let checked = 0
  let differed = 0

  for (const pair of list) {
    const inputs = pair.inputs()
    const shown: string[] = []
    let bad = 0

    for (const input of inputs) {
      let want: unknown
      let got: unknown

      try {
        want = pair.ts(...input)
      } catch (cause) {
        want = `(threw) ${String(cause).slice(0, 80)}`
      }

      try {
        got = pair.term(...input)
      } catch (cause) {
        got = `(threw) ${String(cause).slice(0, 80)}`
      }

      checked++

      if (JSON.stringify(want) !== JSON.stringify(got)) {
        bad++
        differed++

        if (shown.length < (verbose ? 10_000 : 10)) {
          shown.push(
            `      ${JSON.stringify(input)}\n        typescript: ${JSON.stringify(want)}\n        term:       ${JSON.stringify(got)}`,
          )
        }
      }
    }

    console.log(
      `  ${bad === 0 ? 'ok  ' : 'FAIL'} ${pair.name.padEnd(14)} ${inputs.length} inputs, ${bad} differ`,
    )

    for (const line of shown) {
      console.log(line)
    }
  }

  console.log('')
  // the board reads `N pass, M fail` off the last line, so the count it shows is the number of COMPARISONS that
  // agreed rather than the number of pairings: a pairing that covers 16,562 real names is not one check
  console.log(
    `term self-host: ${checked - differed} pass, ${differed} fail  (${list.length} paired over the real corpus)`,
  )

  if (differed > 0) {
    process.exitCode = 1
  }
}

pairs()
  .then(main)
  .catch((cause: unknown) => {
    console.error(cause)
    process.exitCode = 1
  })
