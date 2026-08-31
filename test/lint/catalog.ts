// Write note/term/lint-rules.md: every lint rule, its code, what it catches, and where it is defined.
//
// GENERATED, so it cannot drift. The page is built from the RULES registry and from each rule file's own leading
// comment, which is where the real explanation already lives. Hand-writing 36 entries produces a page that is wrong
// within a month and wrong silently, because nothing compares it to the registry.
//
// It REPORTS by default and WRITES only on --commit, the house rule, so running it to see the diff cannot rewrite
// the page by accident. As a gate it runs without --commit and fails when the page on disk is out of date, which is
// what keeps it honest.
//
// Run: npx tsx test/lint/catalog.ts             (check: does the page match the registry)
//      npx tsx test/lint/catalog.ts --commit    (write it)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { RULES } from '@term/make/code/lint/lint'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const RULE_DIR = join(TERM, 'deck/make/code/lint/rules')
const PAGE = join(TERM, '../../../../note/term/lint-rules.md')

// the rule file each rule is defined in, by its exported name turned back into kebab
function fileFor(name: string): string | undefined {
  const candidate = join(RULE_DIR, `${name}.ts`)

  return existsSync(candidate) ? `${name}.ts` : undefined
}

// a rule file opens with a comment block explaining what it catches and why. That is the description: it is written
// where the rule is, so it is the copy most likely to be right.
function leadingNote(file: string): string {
  const text = readFileSync(join(RULE_DIR, file), 'utf8')
  const lines: string[] = []

  for (const line of text.split('\n')) {
    if (!line.startsWith('//')) {
      break
    }

    lines.push(line.replace(/^\/\/ ?/, '').trim())
  }

  // the first paragraph only: the rest is history and rationale, which belongs in the file rather than the catalog
  const stop = lines.indexOf('')
  const first = (stop === -1 ? lines : lines.slice(0, stop)).join(' ')

  // drop the `L0xx:` prefix the file opens with, since the table has its own column for it
  return first.replace(/^L\d+:\s*/, '')
}

const rows = [...RULES].sort((a, b) => a.code.localeCompare(b.code))

const body = [
  '# Lint rules',
  '',
  '**Generated. Do not edit.** Run `npx tsx test/lint/catalog.ts --commit` from',
  '`deck/term/deck/term` after adding or changing a rule. `pnpm term:test` fails',
  'when this page and the registry disagree.',
  '',
  `${rows.length} rules. \`term lint\` runs them all; the editor shows them as you type.`,
  '',
  'A rule reports by default and fixes nothing unless it says it is fixable: a',
  'rename or a restructure has to update every reference, which is a refactor',
  'rather than a local edit.',
  '',
  '| code | rule | severity | fixable | catches |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(rule => {
    const file = fileFor(rule.name)
    const note = file ? leadingNote(file) : rule.docs

    return `| \`${rule.code}\` | \`${rule.name}\` | ${rule.severity} | ${rule.fixable ? 'yes' : 'no'} | ${note} |`
  }),
  '',
  '## Where they live',
  '',
  'One file per rule in `deck/term/deck/term/deck/make/code/lint/rules/`, registered',
  'in `RULES` in `deck/make/code/lint/lint.ts`. A rule is a `check(target, context)`',
  'over the milled program, so it sees the same AST the checker does.',
  '',
  '`test/lint/audit.ts` reports, for every rule, whether a test names it and how many',
  'findings it produces across the stdlib, `@term/site`, `@term/face` and `@term/host`.',
  'It fails when a rule has no test at all, which is the state that let `L001` and',
  '`L005` report 10,190 findings that were all the compiler\'s own generated names and',
  'the language\'s own signature-only tasks.',
  '',
  '## Writing one',
  '',
  'A rule can also be written in Term rather than TypeScript: `deck/make/code/lint/seed-rule.ts`',
  'loads them, and they drop into the same registry. See `test/lint/seed-rule.ts`.',
  '',
].join('\n')

const current = existsSync(PAGE) ? readFileSync(PAGE, 'utf8') : ''
const same = current === body

if (process.argv.includes('--commit')) {
  writeFileSync(PAGE, body)
  console.log(`wrote note/term/lint-rules.md (${rows.length} rules)`)
} else if (!same) {
  console.log(
    'note/term/lint-rules.md is out of date. Run `npx tsx test/lint/catalog.ts --commit` from deck/term/deck/term',
  )
}

console.log(`\ncatalog: ${same || process.argv.includes('--commit') ? 1 : 0} pass, ${same || process.argv.includes('--commit') ? 0 : 1} fail`)

if (!same && !process.argv.includes('--commit')) {
  process.exit(1)
}
