// Is anything reading `.tree` syntax with a regex instead of the parser?
//
// WHY THIS EXISTS. There is ONE parser for `.tree` (note/project/term/one-parser.md). The rule was broken INSIDE the compiler
// itself: deck/make/code/compile/load.ts discovered a module's imports with a column-0 line scan, and that scan
// counted the `<` and `>` on `#` comment lines toward text-literal balance. One bare `<` in an English sentence made
// every `load` in the file vanish, and every imported name failed later as `unknown-name`, pointing nowhere near the
// comment. It was almost all of @term/face's 40 errors and took a line-by-line bisect to find.
//
// A rule nothing checks comes back. This looks for a regex anchored on a Term head word, which is what a second
// reader of the grammar looks like every time.
//
// Run: pnpm term:one-parser        (report; non-zero if a new one appears, or a listed one goes away)
//      pnpm term:one-parser --list (every match, allowed or not)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { TERM_ROOT } from './root'

const ROOT = TERM_ROOT
const TERM = TERM_ROOT
const SCAN = [join(TERM, 'deck'), join(TERM, 'test'), join(ROOT, 'task/term')]

// the head words a `.tree` line can open with. A regex anchored on one of these is reading the grammar.
const HEADS = [
  'load', 'bear', 'deck', 'form', 'task', 'note', 'view', 'hook', 'call', 'save', 'host', 'link',
  'find', 'take', 'like', 'send', 'fork', 'walk', 'make', 'read', 'bind', 'mark', 'test', 'tree',
  'fuse', 'dock', 'slot', 'case', 'halt', 'rule', 'role', 'mill', 'mine', 'mint',
].join('|')

// `/^\s*load\s`, `/^(load|bear)\b`, `/(^|\n)tree\s`: a pattern anchored at a line start on a head word
const GRAMMAR_REGEX = new RegExp(
  String.raw`/\^?[^/\n]*?(?:\^|\(\^\|\\n\))\\?s?\*?\\?\(?(?:${HEADS})(?:\||\)|\\s|\\b|\s)[^/\n]*/[gimsuy]*`,
  'g',
)

// Allowed, each with the reason it is not a second reader of the grammar. A draft probe reads `mark draft` and the
// old `note draft` both, as `/^(mark|note) draft/`. A BASELINE, not permission: this fails if
// a match appears outside the list, and fails if a listed one disappears, so the list cannot rot.
const ALLOWED: Record<string, string> = {
  // build-worker.ts, hold.ts, make.ts and roll.ts probed for `test ` themselves until 2026-10-04, when `buildable`
  // (call/code/make.ts) became the one decision of what a file compiles as, through test-preprocess.ts below
  'deck/call/code/mark.ts':
    'the `deck @term/mark` manifest line, to recognize the benchmark suite\'s own folder by its name. It reads no structure',
  'deck/call/code/test-preprocess.ts':
    'the `test <phrase>` preprocessor itself: it rewrites test blocks into tasks BEFORE the file is Term, so there is nothing yet to parse',
  'task/term/await-migrate.ts':
    'the same `mark draft` marker probe, to skip shelved files the way the build walk does. Each file it rewrites is compiled before and after by the real compiler, and must emit the same TypeScript and Rust',
  'task/term/base-gate.ts':
    'the `mark draft` marker probe, to skip shelved test files the way the build walk does. Every file it keeps goes through the real parser, mill and checker, once per backend',
  'task/term/base-marks.ts':
    'the `mark draft`, `mark stable` and `mark unstable` marker lines (and their old `note` spellings), checked to decide whether a module is live and marked. It never reads a module\'s structure',
  'task/term/base-reference.ts':
    'the `#` comment lines above a `task`, `form` or `bind` head, which the parse tree does not keep. Every form, task, parameter and type on a page comes from the parser and the mill',
  'task/term/guard-migrate.ts':
    'a cheap filter for files that may hold a guard, and the guard line the PARSER already chose, checked to read exactly `mark unsafe` before it is split in two. Which line is a guard is the parse tree\'s answer, and each rewrite is proven by identical TypeScript from the real compiler',
  'task/term/seat-migrate.ts':
    'a cheap filter for files holding a `rule` and a `mark <name>` line, the column the PARSER placed each binder at, checked to read `mark` before it becomes `seat`, and backquoted binders in `#` comments, which the parse tree does not keep. Which `mark` is a binder is the parse tree\'s answer, and each rewrite is proven by the reparsed tree printing the same once its `seat` heads read `mark` again',
  'task/term/lean-equal.ts':
    'the same `mark draft` marker probe, to skip shelved files the way the build walk does. Both spellings it compares, longhand and lean, are compiled by the real parser, mill and checker',
  'task/term/mark-metadata.ts':
    'the same `mark draft` marker probe, and a `note <word>` line to find the files the migration has left to rewrite. Every rewrite is proven by identical TypeScript and Rust from the real compiler',
  'task/term/mill-coverage.ts':
    'the `mark draft` marker probe, to skip shelved files the way the build walk does. Its grammar reading goes through the parser',
  'task/term/mint-parity.ts':
    'the same `mark draft` marker probe, to skip shelved files the way the build walk does. Both programs it compares are built by real readers: compile/mill.ts and the mill executor over the parsed tree',
  'task/term/native-gate.ts':
    'the `mark draft` marker probe, to skip shelved files the way the build walk does',
  'task/term/native-surface.ts':
    'the same `mark draft` marker probe, to skip shelved files the way the build walk does. It compares which module FILES exist per backend and never reads what is inside one',
  'test/compile/await-mark.ts':
    'a test asserting the TEXT `term lint --fix` wrote: `mark stable` where `note stable` was. The text is the thing under test, and what it means is held by compiling both spellings to one program',
  'task/term/find-migrate.ts':
    'a migration that places LINES: the manifest `deck <name>` line, the column-0 `load <path>` line a `find` goes under, the `mark` lines it steps past, and stale `bear` lines it repairs. Which names need a find comes from the census and the compiler, and every rewrite is proven by identical TypeScript and Rust from the real compiler',
  'task/term/self-host-left.ts':
    'the same `mark draft` marker probe, to skip shelved files the way the build walk does',
  'task/term/one-parser.ts':
    'this check, whose own pattern necessarily contains the head words it looks for',
  'task/term/sorted-map-bench.ts':
    'the one `host degree, N` line of a COPY of the sorted map, changed to the degree being measured. It reads no structure, and the copy is built by the real compiler',
  'task/term/port-native.ts':
    'the same `mark draft` marker probe, to skip shelved files the way the build walk does. It hands every file it keeps to the real compiler, once per backend, and never reads what is inside one',
  'task/term/unknown-types.ts':
    'the same `mark draft` marker probe',
  'task/term/edit-replay-callers.ts':
    'the first line of a file the replay itself wrote as `load ./<path>` (its `files` list holds only the files it added), rewritten to the path from the folder the `move-file` edit moves it to. It reads no structure, and every build after the edit is the real compiler compared with a clean build',
  'task/term/host-text.ts':
    'the census of decision 113 over the TEXT a person wrote in a suite: a `bind` body\'s characters as written, which its limits count before any escape is read, the `# host <word>: <reason>` line above a bind, which the parse tree does not keep, and a `test <title>` line matched against a hold\'s literal. It decides nothing a build reads: every suite it measures is compiled by the parser, mill and checker',
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'host' || entry === '.git' || entry === 'tmp') {
      continue
    }

    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }

  return out
}

const listOnly = process.argv.includes('--list')
const found = new Map<string, string[]>()

for (const dir of SCAN) {
  for (const file of walk(dir)) {
    const hits = [...readFileSync(file, 'utf8').matchAll(GRAMMAR_REGEX)].map(m => m[0])

    if (hits.length > 0) {
      found.set(relative(ROOT, file), hits)
    }
  }
}

let added = 0
let gone = 0

for (const [file, hits] of [...found].sort()) {
  const why = ALLOWED[file]

  if (listOnly) {
    console.log(`${why ? 'allow' : 'NEW  '} ${file}  (${hits.length})`)

    for (const hit of hits.slice(0, 4)) {
      console.log(`        ${hit}`)
    }

    continue
  }

  if (!why) {
    added++
    console.log(`NEW    ${file} reads .tree syntax with a regex, and nothing says why:`)

    for (const hit of hits.slice(0, 4)) {
      console.log(`         ${hit}`)
    }

    console.log('       Parse it instead. See note/project/term/one-parser.md')
  }
}

for (const file of Object.keys(ALLOWED).sort()) {
  if (!found.has(file)) {
    gone++
    console.log(`GONE   ${file} no longer matches, so take it off ALLOWED`)
  }
}

if (!listOnly) {
  console.log(
    `\nterm one-parser: ${found.size} files match, ${Object.keys(ALLOWED).length} allowed with a reason, ${added} unexplained`,
  )
}

if (added > 0 || gone > 0) {
  process.exit(1)
}
