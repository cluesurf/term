// `loan <x>` to `read <x>`, wherever `loan` heads a group of Term source: in `.tree` files and in the Term source the
// TypeScript tests hold in template literals. `loan` was read as `read` and borrowed nothing, and the bridge refuses it
// since 2026-10-22 (compile/mint-bridge.ts, term/affine-kinds decision 002). No deprecation period, so every caller
// moves in the same change.
//
// WHICH `loan`. Read off the concrete tree with the compiler's own parser, never a pattern: a group whose head word is
// `loan`, at any depth. A `loan` inside a text literal or a comment is not a head and is left.
//
// THE PROOF, per file or literal, before anything is written: the rewrite is the same length (`loan` and `read` are
// four letters), the rewritten text parses, it has no `loan` head left, and its printed tree is the old printed tree
// with exactly the rewritten heads changed. `loan` and `read` mint to the same node (mill/code/tree/code/seed/mint.tree
// `seed-loan`), so the compiled program is unchanged, which the suites that hold the literals then show.
//
// Reports by default; writes only with --commit, reading each file again immediately before writing it.
//
//   pnpm exec tsx task/term/loan-migrate.ts            report
//   pnpm exec tsx task/term/loan-migrate.ts --commit   write

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { parse, printTree } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import { headWord, spanOfNode } from '@term/make/code/compile/mill-run'
import { TERM_ROOT, parentPaths } from './root'

const TERM = TERM_ROOT
const HOME = TERM_ROOT
// Term source only: mesh/deck/back holds natural-language lexicons where "loan" is a word of English. The mill's own
// grammar keeps reading `loan`, so the bridge can name it when it refuses it, and a shelved file that records an old
// layout (`mark draft`) is left as it was written
const ROOTS = [join(TERM, 'deck'), join(TERM, 'test'), join(TERM, 'mark'), join(TERM, 'task'), ...parentPaths('deck/term/deck/seed.tree'), ...parentPaths('deck/zone'), ...parentPaths('mesh/site')]
const LEFT = [join(TERM, 'deck/mill/code/'), join(TERM, 'deck/bind/bind/file.tree')]
const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])
const commit = process.argv.includes('--commit')

function files(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
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
      files(full, out)
    } else if (
      (name.endsWith('.tree') || (name.endsWith('.ts') && !name.endsWith('.d.ts'))) &&
      !full.includes('/test/parser/file/') &&
      !LEFT.some(left => full.startsWith(left))
    ) {
      out.push(full)
    }
  }
}

// the offsets (in `text`) of every `loan` that heads a group
function loanHeads(text: string): number[] | undefined {
  const tree = parse({ file: 'loan.tree', text })

  if (!tree.ok) {
    return undefined
  }

  const lines = text.split('\n')
  const base: number[] = []
  let at = 0

  for (const line of lines) {
    base.push(at)
    at += line.length + 1
  }

  const out: number[] = []

  const visit = (node: Node): void => {
    if (node.kind !== 'group') {
      return
    }

    // `loan x`, with what it reads under it. A bare `loan` is a name (`task loan`, `like loan`), not the word
    if (headWord(node) === 'loan' && node.nodes.length >= 2) {
      const span = spanOfNode(node)

      if (span) {
        out.push((base[span.start.line] ?? 0) + span.start.column)
      }
    }

    for (const child of node.nodes) {
      visit(child as Node)
    }
  }

  for (const node of tree.tree.nodes) {
    visit(node as Node)
  }

  return out
}

// rewrite one stretch of Term source, proven; undefined when it holds no `loan` head, a text when refused
function rewrite(text: string): { after: string; sites: number } | string | undefined {
  const heads = loanHeads(text)

  if (heads === undefined) {
    return /(^|[\s,(])loan[ (]/m.test(text) ? 'does not parse' : undefined
  }

  if (heads.length === 0) {
    return undefined
  }

  let after = text

  for (const offset of heads) {
    if (after.slice(offset, offset + 4) !== 'loan') {
      return `no \`loan\` at offset ${offset}`
    }

    after = `${after.slice(0, offset)}read${after.slice(offset + 4)}`
  }

  const left = loanHeads(after)

  if (left === undefined || left.length > 0) {
    return 'the rewrite does not parse, or keeps a `loan` head'
  }

  const before = parse({ file: 'loan.tree', text })
  const back = parse({ file: 'loan.tree', text: after })

  if (!before.ok || !back.ok) {
    return 'the rewrite does not parse'
  }

  // the printed trees differ in exactly the rewritten heads
  const printedBefore = printTree(before.tree).split('\n')
  const printedAfter = printTree(back.tree).split('\n')
  let changed = 0

  if (printedBefore.length !== printedAfter.length) {
    return 'the tree changes shape'
  }

  for (let row = 0; row < printedBefore.length; row++) {
    const one = printedBefore[row] as string
    const two = printedAfter[row] as string

    if (one === two) {
      continue
    }

    const count = (one.match(/\bloan\b/g) ?? []).length

    if (one.replace(/\bloan\b/g, 'read') !== two) {
      return `the tree changes beyond the rewritten heads: ${one.trim()}`
    }

    changed += count
  }

  if (changed !== heads.length) {
    return `the tree changes ${changed} words for ${heads.length} heads`
  }

  return { after, sites: heads.length }
}

function main(): void {
  const all: string[] = []

  for (const root of ROOTS) {
    files(root, all)
  }

  const name = (file: string) => relative(HOME, file)
  let written = 0
  let sites = 0
  let refused = 0

  for (const file of all) {
    const text = readFileSync(file, 'utf8')

    if (!/\bloan\b/.test(text)) {
      continue
    }

    let after = text
    let count = 0

    if (file.endsWith('.tree')) {
      const done = rewrite(text)

      if (typeof done === 'string') {
        console.log(`  refused ${name(file)}: ${done}`)
        refused++
        continue
      }

      if (done) {
        after = done.after
        count = done.sites
      }
    } else {
      // the Term source in the test's template literals, each read as its own text; a rewrite keeps every offset
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const literals: { start: number; body: string }[] = []

      const visit = (node: ts.Node): void => {
        if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
          const start = node.getStart(source) + 1
          literals.push({ start, body: text.slice(start, node.getEnd() - 1) })

          return
        }

        ts.forEachChild(node, visit)
      }

      visit(source)

      for (const literal of literals) {
        if (!/\bloan\b/.test(literal.body)) {
          continue
        }

        // an escaped newline in a one-line literal is two characters to the file and one line break to Term
        const escaped = literal.body.includes('\\n') && !literal.body.includes('\n')
        const body = escaped ? literal.body.replace(/\\n/g, '\n') : literal.body
        const done = rewrite(body)

        if (typeof done === 'string') {
          console.log(`  left a literal in ${name(file)}: ${done}`)
          refused++
          continue
        }

        if (done) {
          const rewritten = escaped ? done.after.replace(/\n/g, '\\n') : done.after
          after = `${after.slice(0, literal.start)}${rewritten}${after.slice(literal.start + literal.body.length)}`
          count += done.sites
        }
      }
    }

    if (count === 0) {
      continue
    }

    if (commit) {
      if (readFileSync(file, 'utf8') !== text) {
        console.log(`  refused ${name(file)}: changed on disk since it was read`)
        refused++
        continue
      }

      writeFileSync(file, after)
    }

    console.log(`  ${commit ? 'WROTE' : 'WOULD WRITE'} ${name(file)}: ${count}`)
    written++
    sites += count
  }

  console.log('')
  console.log(`term loan-migrate: ${written} files ${commit ? 'written' : 'to write'} (${sites} \`loan\` -> \`read\`), ${refused} refused`)
}

main()
