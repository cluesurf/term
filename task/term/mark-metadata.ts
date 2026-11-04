// `note <metadata>` to `mark <metadata>` across the repository, proven per file
// (note/project/term/await-by-default-and-mark-metadata.md, sections 4 and 5).
//
// WHICH `note`. Exactly the ones check/note-metadata.ts calls metadata, which is what the compiler warns about
// (`note-metadata`) and what `term lint --fix` rewrites (L053): a bare metadata word (`async`, `unsafe`, `draft`,
// `stable`, `private`, ...), nothing after it but a guarded body or a `name`, and not under a `call`, `take`, `link`,
// `like` or `twin`. A `note <text>` is documentation and is never touched, nor is a field NAMED note.
//
// THE PROOF, per file, before anything is written:
//   - a file that builds: compiled before and after, it must emit the same TypeScript, and the same Rust where it
//     builds for Rust (the mill mints `mark <word>` as the `note` it replaces, so this is the claim that it does)
//   - a SHELVED file (`note draft`), which no build reads: it must still be shelved after, by the build walk's own
//     test, and its tree must be the old tree with `note` read as `mark` at exactly the rewritten heads
//   - a file that does not build and is not shelved is not evidence, and is listed and left as it is
//
// Reports by default; writes only with --commit, reading each file again immediately before writing it and refusing
// one that changed since it was read.
//
//   pnpm term:mark-metadata                        report
//   pnpm term:mark-metadata --only deck/base       a path substring
//   pnpm term:mark-metadata --commit               write
//   pnpm term:mark-metadata --no-rust              TypeScript only

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { makeParseMemo } from '@term/make/code/compile/load'
import type { CompileCache } from '@term/make/code/compile/cache'
import { projectCache } from '@term/call/code/cache-store'
import { noteMetadataSites } from '@term/make/code/check/note-metadata'
import { parse, printTree } from '@term/make/code/parser/tree'
import { TERM_ROOT, parentPaths } from './root'

const TERM = TERM_ROOT
const HOME = TERM_ROOT

const ROOTS = [join(TERM, 'deck'), join(TERM, 'test'), join(TERM, 'mark'), join(TERM, 'task'), ...parentPaths('deck/zone'), ...parentPaths('deck/term/deck/land.tree'), ...parentPaths('mesh/deck'), ...parentPaths('mesh/site')]

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const rust = !argv.includes('--no-rust')
const onlyAt = argv.indexOf('--only')
const only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    // `host/` beside a deck.tree is build output, and `deck/host` is the @term/host PACKAGE, which is source
    const output = name === 'host' ? existsSync(join(dir, 'deck.tree')) : SKIP.has(name)

    if (output || name.endsWith('-cache')) {
      continue
    }

    const full = join(dir, name)
    const stat = lstatSync(full)

    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      trees(full, out)
    } else if (name.endsWith('.tree')) {
      out.push(full)
    }
  }
}

function rootOf(file: string): string {
  let dir = dirname(file)

  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'deck.tree'))) {
      return dir
    }

    dir = dirname(dir)
  }

  return dirname(file)
}

const parsed = makeParseMemo()
const caches = new Map<string, CompileCache>()

function cacheOf(root: string): CompileCache {
  const known = caches.get(root) ?? projectCache(root)
  caches.set(root, known)

  return known
}

type Emit = { ok: true; ts: string; rs: string } | { ok: false }

function emit(file: string, text: string, root: string): Emit {
  const options = { resolve: projectResolver(root), roleOf: projectRoleOf(root), leanOf: projectLeanOf(root), parsed, cache: cacheOf(root) }

  try {
    const node = compile({ file, text }, options)

    if (!node.ok) {
      return { ok: false }
    }

    if (!rust) {
      return { ok: true, ts: node.typescript, rs: '' }
    }

    const native = compile({ file, text }, { ...options, resolve: projectResolver(root, 'rust'), env: 'rust' })

    return { ok: true, ts: node.typescript, rs: native.ok ? emitRust(native.program) : 'rust: does not build' }
  } catch {
    return { ok: false }
  }
}

// the build walk's own test (call/code/make.ts, isDraftTree)
function shelved(text: string): boolean {
  return /^(mark|note) draft\s*$/m.test(text.slice(0, 2000))
}

// `note` -> `mark` at each site, which are all on the `note` word itself
function rewrite(text: string, sites: { span: { start: { line: number; column: number } } }[]): string {
  const lines = text.split('\n')

  for (const site of sites) {
    const { line, column } = site.span.start
    const row = lines[line] ?? ''

    if (row.slice(column, column + 4) !== 'note') {
      throw new Error(`line ${line + 1}: expected \`note\` at column ${column}`)
    }

    lines[line] = `${row.slice(0, column)}mark${row.slice(column + 4)}`
  }

  return lines.join('\n')
}

type Outcome =
  | { kind: 'written'; sites: number; words: string[]; text: string; original: string; how: 'compiled' | 'shelved' }
  | { kind: 'untouched' }
  | { kind: 'refused'; why: string }

function migrate(file: string): Outcome {
  const text = readFileSync(file, 'utf8')

  // a generated file follows its generator (call/code/cask-generate.ts writes `mark` now), never this rewrite
  if (/^# GENERATED\b/.test(text)) {
    return { kind: 'untouched' }
  }

  if (!/^\s*note [a-z]/m.test(text)) {
    return { kind: 'untouched' }
  }

  const tree = parse({ file, text })

  if (!tree.ok) {
    return { kind: 'refused', why: 'does not parse' }
  }

  const sites = noteMetadataSites(tree.tree, text)

  if (sites.length === 0) {
    return { kind: 'untouched' }
  }

  let after: string

  try {
    after = rewrite(text, sites)
  } catch (cause) {
    return { kind: 'refused', why: `a site is not where the tree says: ${String(cause).slice(0, 120)}` }
  }
  const words = sites.map(site => site.word)

  // a shelved file: still shelved, and the same tree with the rewritten heads read back as `note`
  if (shelved(text)) {
    const back = parse({ file, text: after })

    if (!shelved(after) || !back.ok) {
      return { kind: 'refused', why: 'shelved, and the rewrite would unshelve or unparse it' }
    }

    // every `mark` head read as `note` on both sides: the trees must then be the same tree
    const asNote = (printed: string) => printed.split('\n').map(line => line.replace(/^(\s*)mark\b/, '$1note')).join('\n')
    const same = asNote(printTree(back.tree)) === asNote(printTree(tree.tree))

    return same
      ? { kind: 'written', sites: sites.length, words, text: after, original: text, how: 'shelved' }
      : { kind: 'refused', why: 'shelved, and the tree changes beyond the rewritten heads' }
  }

  const root = rootOf(file)
  const before = emit(file, text, root)

  if (!before.ok) {
    return { kind: 'refused', why: 'does not build as it is, so there is nothing to compare' }
  }

  const now = emit(file, after, root)

  if (!now.ok) {
    return { kind: 'refused', why: 'builds as it is and not after the rewrite' }
  }

  if (now.ts !== before.ts || now.rs !== before.rs) {
    return { kind: 'refused', why: `the output changes (${now.ts !== before.ts ? 'TypeScript' : 'Rust'})` }
  }

  return { kind: 'written', sites: sites.length, words, text: after, original: text, how: 'compiled' }
}

function main(): void {
  const files: string[] = []

  for (const dir of ROOTS) {
    trees(dir, files)
  }

  // the parser's fixtures define what `note` parses to, and are rewritten by hand when that changes
  // `--only a,b`: any of the substrings
  const wanted = only ? only.split(',') : []
  const chosen = files.filter(file => !/\/test\/parser\/file\//.test(file) && (wanted.length === 0 || wanted.some(part => file.includes(part))))
  const tally = { written: 0, untouched: 0, refused: 0, sites: 0, shelved: 0 }
  const words = new Map<string, number>()
  const refusals = new Map<string, string[]>()
  const name = (file: string) => relative(HOME, file)
  let at = 0

  console.log(`term mark-metadata: ${chosen.length} files, TypeScript${rust ? ' and Rust' : ''}${commit ? ', writing' : ', report only'}`)

  for (const file of chosen) {
    at++
    process.stderr.write(`  [${at}/${chosen.length}] ${name(file)}\n`)

    const outcome = migrate(file)

    if (outcome.kind === 'untouched') {
      tally.untouched++
      continue
    }

    if (outcome.kind === 'refused') {
      tally.refused++
      refusals.set(outcome.why, [...(refusals.get(outcome.why) ?? []), name(file)])
      continue
    }

    if (commit) {
      if (readFileSync(file, 'utf8') !== outcome.original) {
        tally.refused++
        refusals.set('changed on disk since it was read', [...(refusals.get('changed on disk since it was read') ?? []), name(file)])
        continue
      }

      writeFileSync(file, outcome.text)
    }

    process.stderr.write(`  ${commit ? 'WROTE' : 'WOULD WRITE'} ${name(file)}: ${outcome.words.join(' ')} (${outcome.how})\n`)

    tally.written++
    tally.sites += outcome.sites

    if (outcome.how === 'shelved') {
      tally.shelved++
    }

    for (const word of outcome.words) {
      words.set(word, (words.get(word) ?? 0) + 1)
    }
  }

  console.log('')

  for (const [why, list] of refusals) {
    console.log(`  refused ${list.length}: ${why}`)

    for (const file of list.slice(0, 40)) {
      console.log(`    ${file}`)
    }

    if (list.length > 40) {
      console.log(`    ... and ${list.length - 40} more`)
    }
  }

  console.log('')
  console.log(`  by word: ${[...words].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ')}`)
  console.log('')
  console.log(
    `term mark-metadata: ${tally.written} files ${commit ? 'written' : 'to write'} (${tally.sites} \`note\` -> \`mark\`, ${tally.shelved} of them shelved files proven by tree), ${tally.untouched} untouched, ${tally.refused} refused`,
  )
}

main()
