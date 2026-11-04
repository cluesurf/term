// Fold @term/feed into @term/mill (note/project/term/mill-merge-and-role-scopes.md, phase 2): the cursor library to
// deck/mill/code/feed.tree, each format folder to deck/mill/code/text/<format> or deck/mill/code/blob/<format>, the
// feed's tests to deck/mill/test/feed/.
//
// TEXT OR BLOB is read off each format's own grammars, by the build's own question: `feedMineSubstrate` says whether
// a grammar's leaves read a text cursor or a byte cursor. A format whose grammars give no answer (shelved, or no leaf
// rules yet) is placed by what the format is, from the table below, and the report says which were.
//
// A relative load that stays inside its format folder is kept (the folder moves whole). One that leaves it, to the
// cursor library or to another format, is rewritten to a package path, `@term/mill/feed` or
// `@term/mill/<text|blob>/<path>`, because two formats that load each other may now live under different folders.
// Loads are found with the compiler's parser, never a pattern.
//
// Reports by default. `--commit` rewrites the loads, then moves.
//
//   pnpm term:feed-move            report
//   pnpm term:feed-move --commit   rewrite and move

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import { headWord, spanOfNode, wordOf } from '@term/make/code/compile/mill-run'
import { feedMineSubstrate, readFeedMineGrammar } from '@term/make/code/compile/feed-mill'
import { TERM_ROOT } from './root'

const TERM = TERM_ROOT
const FEED = join(TERM, 'deck/feed/code')
const FEED_TEST = join(TERM, 'deck/feed/test')
const MILL = join(TERM, 'deck/mill/code')
const MILL_TEST = join(TERM, 'deck/mill/test/feed')

const commit = process.argv.includes('--commit')

// what a format IS, for the formats whose grammars cannot say (shelved, or no leaf rule yet): a format of bytes is a
// blob, a format of characters is text, whatever its first grammar happens to read
const BLOB = new Set(['7z', 'ai', 'aif', 'audio', 'bit', 'dmg', 'docx', 'elf', 'font', 'gzip', 'http2', 'image', 'iso', 'jar', 'macho', 'otf', 'pdf', 'ppt', 'psd', 'rar', 'rsa', 'tar', 'ttf', 'video', 'woff', 'woff2', 'x86', 'xlsx', 'zip'])
const TEXT = new Set(['ansi', 'ascii', 'cookie', 'css', 'csv', 'datetime', 'email', 'glsl', 'hex', 'html', 'http', 'ipv4', 'javascript', 'json', 'kotlin', 'latin', 'mailbox', 'phone', 'rfc2616', 'rtf', 'sql', 'swift', 'symbol', 'tex', 'tree', 'typescript', 'unicode', 'uri', 'ws-uri', 'xml'])

function files(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = lstatSync(full)

    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      files(full, out)
    } else if (name.endsWith('.tree')) {
      out.push(full)
    }
  }
}

// the substrates a format folder's grammars read, by the build's own inference
function substratesOf(folder: string): Set<string> {
  const found = new Set<string>()
  const all: string[] = []

  files(folder, all)

  for (const file of all.filter(f => f.endsWith('/mine.tree'))) {
    const parsed = parse({ file, text: readFileSync(file, 'utf8') })

    if (!parsed.ok) {
      continue
    }

    const grammar = readFeedMineGrammar(parsed.tree)
    const substrate = grammar.size > 0 ? feedMineSubstrate(grammar) : undefined

    if (substrate) {
      found.add(substrate)
    }
  }

  return found
}

type Placement = { folder: string; home: 'text' | 'blob'; by: string }

function placements(): Placement[] {
  const out: Placement[] = []

  for (const name of readdirSync(FEED).sort()) {
    if (!lstatSync(join(FEED, name)).isDirectory()) {
      continue
    }

    const read = substratesOf(join(FEED, name))
    // `feedMineSubstrate` answers `byte` or `text`
    const byGrammar = read.size === 1 ? ([...read][0] === 'text' ? 'text' : 'blob') : undefined
    const byKind = BLOB.has(name) ? 'blob' : TEXT.has(name) ? 'text' : undefined

    if (!byGrammar && !byKind) {
      throw new Error(`${name}: its grammars do not say text or bytes, and the table does not name it`)
    }

    // the grammar decides where it can; a disagreement with the table is reported, never resolved in silence
    const home = (byGrammar ?? byKind) as 'text' | 'blob'
    const by = byGrammar ? (byKind && byKind !== byGrammar ? `grammar (${[...read].join(', ')}), the table said ${byKind}` : `grammar (${[...read].join(', ')})`) : read.size > 1 ? `table (grammars read ${[...read].join(' and ')})` : 'table'

    out.push({ folder: name, home, by })
  }

  return out
}

// where a file of the feed lives after the move
function movedPath(file: string, homes: Map<string, 'text' | 'blob'>): string {
  if (file.startsWith(FEED_TEST + '/')) {
    return join(MILL_TEST, relative(FEED_TEST, file))
  }

  const inside = relative(FEED, file)

  if (inside === 'base.tree') {
    return join(MILL, 'feed.tree')
  }

  const folder = inside.split('/')[0] as string

  return join(MILL, homes.get(folder) as string, inside)
}

// the package path that reaches a moved file: `@term/mill/<path>`, a folder's base.tree named by the folder
function packagePathOf(moved: string): string {
  return `@term/mill/${relative(MILL, moved).replace(/\.tree$/, '').replace(/\/base$/, '')}`
}

function resolveRelative(from: string, path: string): string | undefined {
  const base = join(dirname(from), path)

  return [`${base}.tree`, join(base, 'base.tree')].find(candidate => existsSync(candidate))
}

// the top folder a feed file belongs to, `base` for the cursor library, `test` for a test
function groupOf(file: string): string {
  if (file.startsWith(FEED_TEST + '/')) {
    return 'test'
  }

  return relative(FEED, file).split('/')[0] as string
}

type Edit = { line: number; column: number; was: string; now: string }

function editsOf(file: string, text: string, homes: Map<string, 'text' | 'blob'>): { edits: Edit[]; unresolved: string[] } {
  const tree = parse({ file, text })
  const edits: Edit[] = []
  const unresolved: string[] = []

  if (!tree.ok) {
    return { edits, unresolved: ['does not parse'] }
  }

  for (const top of tree.tree.nodes as Node[]) {
    if (top.kind !== 'group' || headWord(top) !== 'load') {
      continue
    }

    const target = top.nodes[1] as Node | undefined
    const path = wordOf(target)
    const at = spanOfNode(target)

    if (!path || !at) {
      continue
    }

    if (path.startsWith('@term/feed/')) {
      // `@term/feed/base` and `@term/feed/code/base` are the cursor library
      const rest = path.slice('@term/feed/'.length).replace(/^code\//, '')
      const reached = resolveRelative(join(FEED, 'x.tree'), `./${rest}`)

      if (!reached) {
        unresolved.push(path)
        continue
      }

      edits.push({ line: at.start.line, column: at.start.column, was: path, now: packagePathOf(movedPath(reached, homes)) })
      continue
    }

    if (!path.startsWith('./') && !path.startsWith('../')) {
      continue
    }

    const reached = resolveRelative(file, path)

    if (!reached) {
      unresolved.push(path)
      continue
    }

    // inside one format folder the relative path still holds, since the folder moves whole
    if (groupOf(reached) === groupOf(file) && groupOf(file) !== 'test') {
      continue
    }

    edits.push({ line: at.start.line, column: at.start.column, was: path, now: packagePathOf(movedPath(reached, homes)) })
  }

  return { edits, unresolved }
}

function apply(text: string, edits: Edit[]): string {
  const lines = text.split('\n')

  for (const edit of edits) {
    const row = lines[edit.line] ?? ''

    if (row.slice(edit.column, edit.column + edit.was.length) !== edit.was) {
      throw new Error(`line ${edit.line + 1}: expected ${edit.was} at column ${edit.column}`)
    }

    lines[edit.line] = `${row.slice(0, edit.column)}${edit.now}${row.slice(edit.column + edit.was.length)}`
  }

  return lines.join('\n')
}

function main(): void {
  const placed = placements()
  const homes = new Map(placed.map(p => [p.folder, p.home]))

  console.log('term feed-move: where each format goes')

  for (const p of placed) {
    console.log(`  ${p.home.padEnd(5)} ${p.folder.padEnd(12)} by ${p.by}`)
  }

  const all: string[] = []

  files(FEED, all)
  files(FEED_TEST, all)

  // the test tree's loads of @term/feed, which move with the cursor library
  const outside: string[] = []

  files(join(TERM, 'test'), outside)

  const plan: { file: string; text: string; after: string; edits: Edit[] }[] = []
  const unresolved: string[] = []

  for (const file of [...all, ...outside.filter(f => readFileSync(f, 'utf8').includes('@term/feed/'))]) {
    const text = readFileSync(file, 'utf8')
    const found = editsOf(file, text, homes)

    for (const path of found.unresolved) {
      unresolved.push(`${relative(TERM, file)}: ${path}`)
    }

    if (found.edits.length > 0) {
      plan.push({ file, text, after: apply(text, found.edits), edits: found.edits })
    }
  }

  console.log(`\n  ${plan.length} files, ${plan.reduce((n, p) => n + p.edits.length, 0)} loads to rewrite`)

  for (const p of plan) {
    for (const edit of p.edits) {
      console.log(`    ${relative(TERM, p.file)}:${edit.line + 1}  ${edit.was}  ->  ${edit.now}`)
    }
  }

  if (unresolved.length > 0) {
    console.log(`\n  ${unresolved.length} loads reach no file, left as written:`)

    for (const line of unresolved) {
      console.log(`    ${line}`)
    }
  }

  if (!commit) {
    console.log('\n  report only; --commit rewrites and moves')

    return
  }

  for (const p of plan) {
    if (readFileSync(p.file, 'utf8') !== p.text) {
      throw new Error(`${p.file} changed on disk since it was read; nothing past it was written`)
    }

    writeFileSync(p.file, p.after)
  }

  mkdirSync(join(MILL, 'text'), { recursive: true })
  mkdirSync(join(MILL, 'blob'), { recursive: true })
  mkdirSync(MILL_TEST, { recursive: true })

  for (const p of placed) {
    renameSync(join(FEED, p.folder), join(MILL, p.home, p.folder))
  }

  renameSync(join(FEED, 'base.tree'), join(MILL, 'feed.tree'))

  for (const name of readdirSync(FEED_TEST)) {
    renameSync(join(FEED_TEST, name), join(MILL_TEST, name))
  }

  console.log(`\n  wrote ${plan.length} files, moved ${placed.length} formats, the cursor library and ${readdirSync(MILL_TEST).length} tests`)
}

main()
