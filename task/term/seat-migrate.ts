// `mark <name>` to `seat <name>` wherever it is a theorem's variable, proven per file. The binder was renamed on
// 2026-10-05, and the bridge refuses the old spelling by name (compile/mint-bridge.ts `refuseMarkBinders`).
//
// WHICH `mark`. Read off the concrete tree with the compiler's own parser, never a pattern:
//   - a `mark` directly under a top-level `rule`, or under a `have` directly under one, or among the proof steps of a
//     `hold` that the rule mill reads (rule/hold/mine.tree)
//   - whose second node is a bare word, so `mark <uuid>` (a text, an identity) is never touched
//   - and that is not METADATA: a word from the metadata list with nothing under it (`mark open` on a claim stays)
// Every other `mark` (a task's `mark async`, a twin's knob, a form's `mark tag`) is metadata or another thing and is
// left alone. Comment lines that quote a binder (`# ... / mark k, like integer / ...`) are rewritten too, as text,
// only inside a backquoted span that starts `mark ` and only in a file that has a binder site.
//
// THE PROOF, per file, before anything is written: the rewritten text parses, and its printed tree with every `seat`
// head read back as `mark` is the old printed tree, with exactly as many `seat` heads as sites rewritten. The compiler
// proof is the build itself: `term make` and `term test` over seed.tree give the same rule counts before and after.
//
// Reports by default; writes only with --commit, reading each file again immediately before writing it.
//
//   pnpm term:seat-migrate                         report
//   pnpm term:seat-migrate --survey                where every `mark` under a rule sits, by its parents
//   pnpm term:seat-migrate --only seed.tree        a path substring (several, comma separated)
//   pnpm term:seat-migrate --commit                write
//   pnpm term:seat-migrate --ts [--commit]         the tree source inside the TypeScript tests' template literals,
//                                                  found with the TypeScript compiler and read with the Term parser,
//                                                  by the same rule. A literal that does not parse is left and named
//   pnpm term:seat-migrate --md [--commit]         the ```tree blocks and `<!-- with:` blocks of the Term notes,
//                                                  seed.tree's notes and the skills, by the same rule. Prose is by hand

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { parse, printTree } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import { headWord, spanOfNode, wordOf } from '@term/make/code/compile/mill-run'
import { TERM_ROOT, parentPaths } from './root'

const TERM = TERM_ROOT
const HOME = TERM_ROOT

const ROOTS = [join(TERM, 'deck'), join(TERM, 'test'), join(TERM, 'mark'), join(TERM, 'task'), ...parentPaths('deck/term/deck/seed.tree'), ...parentPaths('deck/zone'), ...parentPaths('mesh/deck'), ...parentPaths('mesh/site')]

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const survey = argv.includes('--survey')
const typescript = argv.includes('--ts')
const onlyAt = argv.indexOf('--only')
const only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])

// check/note-metadata.tree `is-metadata-word`
const METADATA = new Set(['async', 'native', 'unsafe', 'draft', 'stable', 'unstable', 'deprecated', 'keep', 'open', 'roam', 'feature', 'platform', 'shared', 'private'])

// the heads under which a proof step stands, in rule/hold/mine.tree
const STEPS = new Set(['hold', 'fold', 'case', 'self', 'seed', 'rest', 'weld', 'link', 'have'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
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

type Site = { line: number; column: number; name: string; chain: string }

function groupHead(node: Node): string | undefined {
  return node.kind === 'group' ? headWord(node) : undefined
}

// a binder `mark`: a group headed `mark` whose second node is a bare word that is not metadata standing alone
function binderName(group: Node): string | undefined {
  if (group.kind !== 'group' || group.nodes.length < 2) {
    return undefined
  }

  const second = group.nodes[1] as Node

  if (second.kind === 'text') {
    return undefined
  }

  const word = wordOf(second)

  if (word === undefined) {
    return undefined
  }

  const alone = group.nodes.length === 2 && (second.kind === 'name' || (second.kind === 'group' && second.nodes.length === 1))

  if (alone && METADATA.has(word)) {
    return undefined
  }

  return word
}

// every binder `mark` under a top-level `rule`, with the heads above it
function sitesOf(nodes: Node[]): Site[] {
  const sites: Site[] = []

  const visit = (group: Node, chain: string[]): void => {
    if (group.kind !== 'group') {
      return
    }

    const head = groupHead(group)

    if (head === 'mark' && chain.length > 0) {
      const parent = chain[chain.length - 1] as string
      const allowed = parent === 'rule' || (parent === 'have' && chain[chain.length - 2] === 'rule') || STEPS.has(parent)
      const name = binderName(group)
      const at = spanOfNode(group)

      if (name !== undefined && at && (allowed || survey)) {
        sites.push({ line: at.start.line, column: at.start.column, name, chain: [...chain, allowed ? 'mark' : 'mark(left)'].join(' > ') })
      }

      return
    }

    for (const child of group.nodes.slice(1)) {
      visit(child as Node, [...chain, head ?? '?'])
    }
  }

  for (const top of nodes) {
    if (groupHead(top) === 'rule') {
      visit(top, [])
    }
  }

  return sites
}

// a token's line is off by the newlines inside any multi-line text literal above it, so a site's line is where the
// search starts: the first line at or after it, and after the previous site, with `mark ` at that column
function realign(lines: string[], site: Site, floor: number): number | undefined {
  for (let row = Math.max(site.line, floor); row < lines.length; row++) {
    const text = lines[row] as string

    if (text.slice(site.column, site.column + 5) === 'mark ' || (text.slice(site.column) === 'mark' && text.length === site.column + 4)) {
      return row
    }
  }

  return undefined
}

// a backquoted binder in a comment: `mark x, like t` or `... / mark t / ...` inside backquotes
function rewriteComment(line: string): string {
  if (!/^\s*#/.test(line)) {
    return line
  }

  return line.replace(/`[^`]*`/g, quoted => quoted.replace(/(^`|\/ |`)mark (?=[a-z][a-z0-9-]*(,| \/|`))/g, '$1seat '))
}

type Outcome =
  | { kind: 'written'; sites: number; text: string; original: string }
  | { kind: 'untouched' }
  | { kind: 'refused'; why: string }

const chains = new Map<string, number>()

function migrate(file: string): Outcome {
  const text = readFileSync(file, 'utf8')

  if (!/^\s*mark [a-z]/m.test(text) || !/^rule /m.test(text)) {
    return { kind: 'untouched' }
  }

  const tree = parse({ file, text })

  if (!tree.ok) {
    return { kind: 'refused', why: 'does not parse' }
  }

  const sites = sitesOf(tree.tree.nodes as Node[])

  if (survey) {
    for (const site of sites) {
      chains.set(site.chain, (chains.get(site.chain) ?? 0) + 1)
    }

    return { kind: 'untouched' }
  }

  if (sites.length === 0) {
    return { kind: 'untouched' }
  }

  const lines = text.split('\n')
  let floor = 0

  for (const site of [...sites].sort((a, b) => a.line - b.line || a.column - b.column)) {
    const row = realign(lines, site, floor)

    if (row === undefined) {
      return { kind: 'refused', why: `a site is not where the tree says (line ${site.line + 1}, \`mark ${site.name}\`)` }
    }

    const was = lines[row] as string
    lines[row] = `${was.slice(0, site.column)}seat${was.slice(site.column + 4)}`
    floor = row + 1
  }

  const after = lines.map(rewriteComment).join('\n')
  const back = parse({ file, text: after })

  if (!back.ok) {
    return { kind: 'refused', why: 'the rewrite does not parse' }
  }

  const asMark = (printed: string) => printed.split('\n').map(line => line.replace(/^(\s*)seat\b/, '$1mark')).join('\n')
  const seats = (printed: string) => printed.split('\n').filter(line => /^\s*seat\b/.test(line)).length
  const printedBefore = printTree(tree.tree)
  const printedAfter = printTree(back.tree)

  if (asMark(printedAfter) !== printedBefore) {
    return { kind: 'refused', why: 'the tree changes beyond the rewritten heads' }
  }

  if (seats(printedAfter) - seats(printedBefore) !== sites.length) {
    return { kind: 'refused', why: 'the count of `seat` heads is not the count of sites' }
  }

  return { kind: 'written', sites: sites.length, text: after, original: text }
}

function scripts(dir: string, out: string[]): void {
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
      scripts(full, out)
    } else if (name.endsWith('.ts') && !name.endsWith('.generated.ts')) {
      out.push(full)
    }
  }
}

// the binder sites in one TypeScript file's template literals, as offsets of the `mark` word in the file. A literal's
// text between its backquotes is read as written: an interpolation `${x}` stays in it as characters, which the Term
// parser reads as a word, and the rewrite is the same length, so every offset holds
function templateSites(file: string, text: string): { offsets: number[]; unparsed: number } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const offsets: number[] = []
  let unparsed = 0

  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const start = node.getStart(source) + 1
      const body = text.slice(start, node.getEnd() - 1)

      if (/^\s*mark [a-z]/m.test(body) && /^\s*rule /m.test(body)) {
        // read as its own text: its first line, after the backquote, starts at column 0
        const tree = parse({ file, text: body })

        if (!tree.ok) {
          unparsed++
        } else {
          const lines = body.split('\n')
          const base: number[] = []
          let at = 0

          for (const line of lines) {
            base.push(at)
            at += line.length + 1
          }

          let floor = 0

          for (const site of sitesOf(tree.tree.nodes as Node[]).sort((a, b) => a.line - b.line || a.column - b.column)) {
            const row = realign(lines, site, floor)

            if (row !== undefined) {
              offsets.push(start + (base[row] as number) + site.column)
              floor = row + 1
            }
          }
        }
      }

      return
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return { offsets, unparsed }
}

function mainScripts(): void {
  const files: string[] = []

  scripts(join(TERM, 'test'), files)
  scripts(join(TERM, 'deck'), files)

  const wanted = only ? only.split(',') : []
  const name = (file: string) => relative(HOME, file)
  let written = 0
  let sites = 0

  for (const file of files.filter(file => wanted.length === 0 || wanted.some(part => file.includes(part)))) {
    const text = readFileSync(file, 'utf8')

    if (!/mark [a-z]/.test(text)) {
      continue
    }

    const found = templateSites(file, text)

    if (found.unparsed > 0) {
      console.log(`  left ${name(file)}: ${found.unparsed} literal(s) holding a rule that do not parse`)
    }

    if (found.offsets.length === 0) {
      continue
    }

    let after = text

    for (const offset of found.offsets) {
      if (after.slice(offset, offset + 4) !== 'mark') {
        throw new Error(`${name(file)}: expected \`mark\` at offset ${offset}`)
      }

      after = `${after.slice(0, offset)}seat${after.slice(offset + 4)}`
    }

    if (commit) {
      writeFileSync(file, after)
    }

    console.log(`  ${commit ? 'WROTE' : 'WOULD WRITE'} ${name(file)}: ${found.offsets.length}`)
    written++
    sites += found.offsets.length
  }

  console.log('')
  console.log(`term seat-migrate --ts: ${written} files ${commit ? 'written' : 'to write'} (${sites} \`mark\` -> \`seat\`)`)
}

function markdowns(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return
  }

  if (lstatSync(dir).isFile()) {
    out.push(dir)

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
      markdowns(full, out)
    } else if (name.endsWith('.md')) {
      out.push(full)
    }
  }
}

// the tree source in a markdown file: every ```tree fence, and every `<!-- with:` block a guide checks its samples
// against, as [first line, last line) of the file
function treeBlocks(lines: string[]): [number, number][] {
  const blocks: [number, number][] = []

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] as string

    if (/^```tree\b/.test(line)) {
      const end = lines.findIndex((one, index) => index > at && one.startsWith('```'))

      if (end > at) {
        blocks.push([at + 1, end])
        at = end
      }
    } else if (/^<!-- with:\s*$/.test(line)) {
      const end = lines.findIndex((one, index) => index > at && one.startsWith('-->'))

      if (end > at) {
        blocks.push([at + 1, end])
        at = end
      }
    }
  }

  return blocks
}

function mainMarkdown(): void {
  const files: string[] = []

  for (const dir of [...parentPaths('note/term'), ...parentPaths('deck/term/deck/seed.tree'), ...parentPaths('deck/term/CLAUDE.md'), ...parentPaths('.claude/skills')]) {
    markdowns(dir, files)
  }

  const wanted = only ? only.split(',') : []
  const name = (file: string) => relative(HOME, file)
  let written = 0
  let sites = 0

  for (const file of files.filter(file => wanted.length === 0 || wanted.some(part => file.includes(part)))) {
    const text = readFileSync(file, 'utf8')

    if (!/^\s*mark [a-z]/m.test(text)) {
      continue
    }

    const lines = text.split('\n')
    let count = 0
    let unparsed = 0

    for (const [from, to] of treeBlocks(lines)) {
      const block = lines.slice(from, to)
      const tree = parse({ file, text: block.join('\n') })

      if (!tree.ok) {
        unparsed++
        continue
      }

      let floor = 0

      for (const site of sitesOf(tree.tree.nodes as Node[]).sort((a, b) => a.line - b.line || a.column - b.column)) {
        const row = realign(block, site, floor)

        if (row !== undefined) {
          const was = lines[from + row] as string
          lines[from + row] = `${was.slice(0, site.column)}seat${was.slice(site.column + 4)}`
          floor = row + 1
          count++
        }
      }
    }

    if (unparsed > 0) {
      console.log(`  left ${name(file)}: ${unparsed} tree block(s) that do not parse`)
    }

    if (count === 0) {
      continue
    }

    if (commit) {
      writeFileSync(file, lines.join('\n'))
    }

    console.log(`  ${commit ? 'WROTE' : 'WOULD WRITE'} ${name(file)}: ${count}`)
    written++
    sites += count
  }

  console.log('')
  console.log(`term seat-migrate --md: ${written} files ${commit ? 'written' : 'to write'} (${sites} \`mark\` -> \`seat\`)`)
}

function main(): void {
  if (typescript) {
    mainScripts()

    return
  }

  if (argv.includes('--md')) {
    mainMarkdown()

    return
  }

  const files: string[] = []

  for (const dir of ROOTS) {
    trees(dir, files)
  }

  const wanted = only ? only.split(',') : []
  const chosen = files.filter(file => !/\/test\/parser\/file\//.test(file) && (wanted.length === 0 || wanted.some(part => file.includes(part))))
  const tally = { written: 0, untouched: 0, refused: 0, sites: 0 }
  const refusals = new Map<string, string[]>()
  const name = (file: string) => relative(HOME, file)

  console.log(`term seat-migrate: ${chosen.length} files${survey ? ', survey' : commit ? ', writing' : ', report only'}`)

  for (const file of chosen) {
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

    process.stderr.write(`  ${commit ? 'WROTE' : 'WOULD WRITE'} ${name(file)}: ${outcome.sites}\n`)

    tally.written++
    tally.sites += outcome.sites
  }

  if (survey) {
    console.log('')

    for (const [chain, count] of [...chains].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(6)}  ${chain}`)
    }

    return
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
  console.log(`term seat-migrate: ${tally.written} files ${commit ? 'written' : 'to write'} (${tally.sites} \`mark\` -> \`seat\`), ${tally.untouched} untouched, ${tally.refused} refused`)
}

main()
