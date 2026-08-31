// Every lint rule: does a test name it, and does it fire on the tree today?
//
// WHY THIS EXISTS. There are 34 rules and no way to tell, without asking, which of them are load-bearing and which
// are code nobody has run since it was written. A rule that never fires is either a bug that never happens (worth
// knowing) or a rule that no longer matches the grammar and has stopped asking (worth fixing). Both are invisible
// while the count is only "34 rules exist".
//
// It answers three questions per rule, each countable:
//   TEST   does anything under test/lint name it, by rule name or code
//   FIRES  how many findings it produces over every .tree in the packages below
//   the rest is arithmetic
//
// The FIRING count is a report, not a verdict: a rule catching a mistake nobody has made is not thereby wrong, and
// deciding which of those are dead is lint-and-format-0007's catalog. What it FAILS on is a rule that no test names,
// because that is the state both of the audit's own findings came out of. L005 flagged every signature-only task,
// 4,757 of them, and L001 linted the compiler's mangled names rather than the written ones, 5,433 of them; neither
// had a test, and that is not a coincidence. It is 36 of 36 today, so the bar is simply that it stays there.
//
// Run: npx tsx test/lint/audit.ts            (the table)
//      npx tsx test/lint/audit.ts --quiet    (just the summary line)

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { withNativeEnv } from '@term/make/code/compile/native'
import { projectResolver, findTreeFiles } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { lint, RULES } from '@term/make/code/lint/lint'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')

// the packages to lint. Enough Term to be representative, small enough to run inside a gate: the stdlib, the app
// framework, the UI library and the data package.
const PACKAGES = ['seed', 'site', 'face', 'host']

// every test in the tree, not just test/lint: L040 (the data grammar) is exercised by test/compile/mold.ts and
// test/compile/host-tools.ts, and reading only test/lint reported it as untested.
function testText(): string {
  const out: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.ts') && entry.name !== 'audit.ts') {
        out.push(readFileSync(full, 'utf8'))
      }
    }
  }

  walk(join(TERM, 'test'))

  return out.join('\n')
}

const haystack = testText()
const fires = new Map<string, number>()

for (const rule of RULES) {
  fires.set(rule.code, 0)
}

let linted = 0

for (const pkg of PACKAGES) {
  const root = join(TERM, 'deck', pkg)

  if (!existsSync(root)) {
    continue
  }

  const resolve = withNativeEnv('node', projectResolver(root))
  const deckOf = projectDeckOf()

  for (const file of findTreeFiles(root, [], 'node')) {
    const source = readFileSync(file, 'utf8')
    const result = compile({ file, text: source }, { resolve, deckOf })

    if (!result.ok || !result.program) {
      continue
    }

    linted++

    for (const finding of lint(result.program, file, source)) {
      fires.set(finding.code, (fires.get(finding.code) ?? 0) + 1)
    }
  }
}

const quiet = process.argv.includes('--quiet')
const rows = [...RULES].sort((a, b) => a.code.localeCompare(b.code))

let tested = 0
let firing = 0

if (!quiet) {
  console.log(`${'code'.padEnd(6)} ${'rule'.padEnd(32)} ${'test'.padEnd(6)} fires`)
}

for (const rule of rows) {
  const hasTest = new RegExp(`(['"\`])(${rule.name}|${rule.code})\\1|\\b${rule.code}\\b`).test(haystack)
  const count = fires.get(rule.code) ?? 0

  if (hasTest) {
    tested++
  }

  if (count > 0) {
    firing++
  }

  if (!quiet) {
    console.log(
      `${rule.code.padEnd(6)} ${rule.name.padEnd(32)} ${(hasTest ? 'yes' : 'NO').padEnd(6)} ${count}`,
    )
  }
}

const untested = RULES.length - tested

console.log(
  `\n  ${RULES.length} rules, ${tested} named by a test, ${firing} firing on ${linted} files across ${PACKAGES.join(', ')}`,
)

if (untested > 0) {
  console.log(
    `  ${untested} rule(s) no test names. A rule nothing tests is how L001 and L005 came to report 10,190 findings\n` +
      '  that were all the compiler\'s own generated names and the language\'s own signature-only tasks.',
  )
}

console.log(`\nlint-audit: ${tested} pass, ${untested} fail`)

if (untested > 0) {
  process.exit(1)
}
