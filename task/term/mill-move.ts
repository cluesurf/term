// Move the tree dialects of @term/mill from deck/mill/code/<dialect> to deck/mill/code/tree/<dialect>, so the mill can
// hold every grammar: `tree/` for the tree dialects, `text/` and `blob/` for the formats @term/feed held
// (note/project/term/mill-merge-and-role-scopes.md, phase 1).
//
// Every `load @term/mill/...` in every .tree file is resolved to the FILE it reaches today, by the resolver the mill
// loader calls (`resolveMillImport`), and rewritten to that file's new path, `@term/mill/tree/<path>`. So the move
// cannot change what a load reaches. It also ends the ambiguous `code` segment: `@term/mill/code/tell/mine` reached
// code/code/tell while `@term/mill/code/view/seed/mine` fell back to the package root and reached code/view/seed.
// Loads are found with the compiler's parser, never a pattern.
//
// Reports by default. `--commit` rewrites the loads, then moves the folders.
//
//   pnpm term:mill-move            report
//   pnpm term:mill-move --commit   rewrite and move

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import { headWord, spanOfNode, wordOf } from '@term/make/code/compile/mill-run'
import { resolveMillImport } from '@term/make/code/compile/mill-load'
import { TERM_ROOT, parentPaths } from './root'

const TERM = TERM_ROOT
const HOME = TERM_ROOT
const MILL = join(TERM, 'deck/mill/code')
const TREE = join(MILL, 'tree')

const commit = process.argv.includes('--commit')

// the folders that move: everything in the code root today except the new homes
const KEEP = new Set(['tree', 'text', 'blob'])
const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build', '.git'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = lstatSync(full)

    // `host` is build output and `link` the installed packages, each only beside a deck.tree: the mill has grammar
    // folders by both names (code/host, code/form/link), and the first run of this skipped code/form/link
    const output = name === 'host' || name === 'link' ? existsSync(join(dir, 'deck.tree')) : SKIP.has(name)

    if (stat.isSymbolicLink() || output || name.endsWith('-cache')) {
      continue
    }

    if (stat.isDirectory()) {
      trees(full, out)
    } else if (name.endsWith('.tree')) {
      out.push(full)
    }
  }
}

// the file's new home once its dialect folder has moved under tree/
function moved(file: string): string {
  const inside = relative(MILL, file)

  return inside.startsWith('..') || inside.startsWith('tree/') ? file : join(TREE, inside)
}

// the load path that reaches `file` from its new home: `@term/mill/tree/<path>`, a folder's base.tree named by the folder
function loadPathOf(file: string): string {
  const path = relative(MILL, moved(file)).replace(/\.tree$/, '').replace(/\/base$/, '')

  return `@term/mill/${path}`
}

type Edit = { line: number; column: number; was: string; now: string }

function editsOf(file: string, text: string): { edits: Edit[]; unresolved: string[] } {
  const tree = parse({ file, text })
  const edits: Edit[] = []
  const unresolved: string[] = []

  if (!tree.ok) {
    return { edits, unresolved: [`does not parse`] }
  }

  for (const top of tree.tree.nodes as Node[]) {
    if (top.kind !== 'group' || headWord(top) !== 'load') {
      continue
    }

    const target = top.nodes[1] as Node | undefined
    const path = wordOf(target)
    const at = spanOfNode(target)

    if (!path || !at || !path.startsWith('@term/mill/')) {
      continue
    }

    const reached = resolveMillImport(MILL, file, path)

    if (!reached) {
      unresolved.push(path)
      continue
    }

    const now = loadPathOf(reached)

    if (now !== path) {
      edits.push({ line: at.start.line, column: at.start.column, was: path, now })
    }
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
  const files: string[] = []

  for (const dir of [join(TERM, 'deck'), join(TERM, 'test'), join(TERM, 'base'), ...parentPaths('deck/term/deck/seed.tree'), ...parentPaths('deck/zone')]) {
    trees(dir, files)
  }

  const plan: { file: string; text: string; after: string; count: number }[] = []
  const unresolved: string[] = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')

    if (!text.includes('@term/mill/')) {
      continue
    }

    const found = editsOf(file, text)

    for (const path of found.unresolved) {
      unresolved.push(`${relative(TERM, file)}: ${path}`)
    }

    if (found.edits.length > 0) {
      plan.push({ file, text, after: apply(text, found.edits), count: found.edits.length })
    }
  }

  const folders = readdirSync(MILL).filter(name => !KEEP.has(name) && lstatSync(join(MILL, name)).isDirectory())

  console.log(`term mill-move: ${plan.length} files, ${plan.reduce((n, p) => n + p.count, 0)} loads to rewrite; ${folders.length} folders to move: ${folders.join(' ')}`)

  if (unresolved.length > 0) {
    console.log(`\n  ${unresolved.length} loads reach no file today, left as written:`)

    for (const line of unresolved.slice(0, 40)) {
      console.log(`    ${line}`)
    }
  }

  if (!commit) {
    for (const p of plan.slice(0, 12)) {
      console.log(`  ${relative(TERM, p.file)}: ${p.count}`)
    }

    console.log('\n  report only; --commit rewrites and moves')

    return
  }

  for (const p of plan) {
    if (readFileSync(p.file, 'utf8') !== p.text) {
      throw new Error(`${p.file} changed on disk since it was read; nothing past it was written`)
    }

    writeFileSync(p.file, p.after)
  }

  mkdirSync(TREE, { recursive: true })

  for (const folder of folders) {
    renameSync(join(MILL, folder), join(TREE, folder))
  }

  console.log(`  wrote ${plan.length} files, moved ${folders.length} folders into deck/mill/code/tree`)
}

main()
