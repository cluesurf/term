// THE PRELUDE-NAME GATE (term-cli-in-term-0010, note/project/term/traps.md "A prelude helper name can collide").
//
// Every `__term*` helper a prelude, a runtime shim or an inline runtime text defines lands in ONE namespace: the
// emitted module, beside every other prelude spliced into it. A second `__termAt` (an inline text in
// deck/call/code/work/item/emit.tree) broke every port on 2026-10-23. This lists every `__term*` name defined under
// the Term packages and fails when one name is defined with two different bodies. The same prelude written twice
// (a `.tree` and the `.ts` it was ported from) has one body, and passes.
//
// A definition is a `const` / `let` / `var` / `function` / `class` of a `__term` name that starts a line of code or
// starts a line inside a text (after `<`, a quote, a backtick or a `\n`). A definition inside a function of an inline
// text (`((x) => { let __termAt = 0 ... })`) is local to it and not counted. Its body is the rest of its line, with
// `.tree` text escapes undone, the closing of the literal around it dropped, and spaces collapsed.
//
//   pnpm term:prelude-names                  every name, one line each with its definitions; exit 1 on a clash
//   pnpm term:prelude-names --name __termAt  where one name is defined (exit 0 when nowhere: the name is free)
//   pnpm term:prelude-names --quiet          the summary and the clashes only
//   pnpm term:prelude-names --root <dir>     read another tree than deck

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { CALLER_CWD, TERM_ROOT } from './root'

// from this script's own path: tsx runs it as CommonJS (the root package.json names no type), without import.meta
const REPO = TERM_ROOT
const TERM = TERM_ROOT
// `--root <dir>` reads another tree instead (the gate's own proof feeds it a planted clash)
const rootAt = process.argv.indexOf('--root')
const DECKS = rootAt >= 0 ? resolve(CALLER_CWD, process.argv[rootAt + 1]!) : join(TERM, 'deck')

// build output and caches, never a source of a prelude
const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build', 'dist'])
// a bundle (deck/flow/make/server.js is the language server, built from the very modules read here) repeats every
// prelude it bundled, minified: a file this large is output, and is left out
const BUNDLE_BYTES = 512 * 1024
const EXTENSIONS = /\.(tree|ts|mts|cts|js|mjs|cjs)$/

const args = process.argv.slice(2)
const nameAt = args.indexOf('--name')
const asked = nameAt >= 0 ? args[nameAt + 1] : undefined
const quiet = args.includes('--quiet')

type Definition = { name: string; file: string; line: number; body: string }

function files(dir: string, out: string[], skipped: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP.has(entry) || entry.endsWith('-cache')) {
      continue
    }

    const full = join(dir, entry)
    const stat = statSync(full, { throwIfNoEntry: false })

    if (!stat) {
      continue
    }

    if (stat.isDirectory()) {
      files(full, out, skipped)
    } else if (EXTENSIONS.test(entry)) {
      if (stat.size > BUNDLE_BYTES && !entry.endsWith('.tree')) {
        skipped.push(relative(REPO, full))
      } else {
        out.push(full)
      }
    }
  }
}

const DEFINE =
  /(^|[<'"`]|\\n)[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(?:const|let|var|function\*?|class)[ \t]+(__term[A-Za-z0-9_$]+)/g

// the same text however it was spelled: a `.tree` text's escapes undone, the literal's own closing dropped
function bodyOf(rest: string): string {
  return rest
    .replace(/\\([{}<>\\])/g, '$1')
    .replace(/(?:\\n.*)$/, '')
    .replace(/[>'"`]\)*[,;]?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const found: string[] = []
const skipped: string[] = []
files(DECKS, found, skipped)

const definitions: Definition[] = []

for (const file of found) {
  const text = readFileSync(file, 'utf8')

  if (!text.includes('__term')) {
    continue
  }

  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!

    if (!line.includes('__term')) {
      continue
    }

    // a `declare const __termX: any` names a global a prelude defines, it defines nothing
    for (const match of line.matchAll(DEFINE)) {
      const lead = match[1]!

      // in code, a definition counts only at the start of its line (top level or a block's statement); in a text,
      // only right after the literal opens or after a `\n` inside it
      if (lead === '' && match.index !== 0 && line.slice(0, match.index).trim() !== '') {
        continue
      }

      if (/^[ \t]*(?:export[ \t]+)?declare\b/.test(line.slice(match.index + lead.length))) {
        continue
      }

      const name = match[2]!
      const start = match.index + match[0].length - name.length
      definitions.push({ name, file: relative(REPO, file), line: index + 1, body: bodyOf(line.slice(start)) })
    }
  }
}

const byName = new Map<string, Definition[]>()

for (const definition of definitions) {
  const list = byName.get(definition.name) ?? []
  list.push(definition)
  byName.set(definition.name, list)
}

if (asked !== undefined) {
  const list = byName.get(asked) ?? []

  if (list.length === 0) {
    console.log(`${asked}: free, defined nowhere under ${relative(REPO, DECKS)}`)
  }

  for (const definition of list) {
    console.log(`${asked}  ${definition.file}:${definition.line}  ${definition.body.slice(0, 100)}`)
  }

  process.exit(new Set(list.map(one => one.body)).size > 1 ? 1 : 0)
}

const clashes: string[] = []

for (const [name, list] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const bodies = new Set(list.map(one => one.body))

  if (bodies.size > 1) {
    clashes.push(name)
  }

  if (!quiet || bodies.size > 1) {
    console.log(`${bodies.size > 1 ? 'CLASH' : 'ok   '} ${name}  ${list.map(one => `${one.file}:${one.line}`).join('  ')}`)
  }

  if (bodies.size > 1) {
    for (const definition of list) {
      console.log(`        ${definition.file}:${definition.line}  ${definition.body.slice(0, 140)}`)
    }
  }
}

console.log(
  `term prelude-names: ${byName.size} names, ${definitions.length} definitions in ${found.length} files (${skipped.length} bundles left out: ${skipped.join(', ') || 'none'}), ${clashes.length} clash${clashes.length === 1 ? '' : 'es'}`,
)
process.exitCode = clashes.length > 0 ? 1 : 0
