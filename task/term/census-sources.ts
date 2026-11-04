// The checker's census over the Term programs written as files under test and task (decision 096
// rule 8's second reach, item term-self-host-001-0527). census-corpus.ts reads the programs a gate compiles; this reads
// the source files, each built the way its owner builds it, so a census refusal is never hidden by a file it could not
// build:
//
//   project    a folder with a deck.tree: `term make --all` in it
//   test file  a `test <phrase>` block at the top level (test/tree/*): the test preprocessor first, as `term test` and
//              term:base-gate do, then the compiler. Without it `test` is an unknown name, and the 38 such files were
//              most of the 55 the first census could not build
//   other      `term make --all --emit node <file>`. A file that is data or a stylesheet has no program, and says so
//
// Refused on purpose, listed by name below: every test/assurance/twin project (test/assurance/hold.sh owns their
// verdicts) and the fixtures of a refusal test. Their lines still count toward the census codes.
//
//   npx tsx task/term/census-sources.ts [--codes a,b,c] [--only <substring>]
//
// Exit 1 on a census code anywhere, or on a program that should build and did not. Reports only, writes nothing outside
// a built project's own host/.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { carriesTests, preprocessTests } from '@term/call/code/test-preprocess'
import { TERM_ROOT } from './root'

const TERM = TERM_ROOT
const LINE = join(TERM, 'host/line.js')
const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const CODES = (flag('--codes') ?? 'raise-escapes-slot,slot-kink-kept,handle-escapes').split(',')
const only = flag('--only') ?? ''

// each is built by a test that wants this refusal
const REFUSED_ON_PURPOSE = [/^test\/assurance\/twin\//, /^test\/compile\/inspect-native\/generic\.tree$/]
const SKIP_DIR = /(^|\/)(node_modules|host|tmp|\.base|fixture|parser\/file)(\/|$)|-fixture(\/|$)/
const SKIP_NAME = new Set(['deck.tree', 'role.tree', 'laws.tree'])

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)

    if (statSync(full).isDirectory()) {
      if (!SKIP_DIR.test(relative(TERM, full))) {
        walk(full, out)
      }
    } else if (name.endsWith('.tree')) {
      out.push(full)
    }
  }
}

const files: string[] = []
walk(join(TERM, 'test'), files)
walk(join(TERM, 'task'), files)

const projects = files.filter(f => f.endsWith('/deck.tree')).map(dirname)
const inProject = (f: string): boolean => projects.some(p => f.startsWith(`${p}/`))
const loose = files.filter(f => !SKIP_NAME.has(f.slice(f.lastIndexOf('/') + 1)) && !inProject(f))

type Row = { at: string; how: string; code: number; output: string }
const rows: Row[] = []
const run = (cwd: string, ...rest: string[]): { code: number; output: string } => {
  const done = spawnSync('node', [LINE, ...rest], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })

  return { code: done.status ?? 1, output: `${done.stdout}${done.stderr}` }
}

for (const dir of projects) {
  const at = relative(TERM, dir)

  if (at.includes(only)) {
    rows.push({ at: `${at}/`, how: 'project', ...run(dir, 'make', '--all') })
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'term-census-sources-'))

try {
  for (const file of loose) {
    const at = relative(TERM, file)

    if (!at.includes(only)) {
      continue
    }

    const text = readFileSync(file, 'utf8')

    // the test preprocessor's own answer, the one `term make` and `term test` take (call/code/test-preprocess.ts)
    if (carriesTests(text)) {
      // written in the file's own folder under the scratch name would dirty the tree, so a relative load is left to
      // the file's own: test files load packages, and one that loads relatively is reported as what it is
      const lowered = join(scratch, at.replace(/\//g, '_'))
      writeFileSync(lowered, preprocessTests(text).text)
      rows.push({ at, how: 'test file', ...run(TERM, 'make', '--all', '--emit', 'node', lowered) })
    } else {
      rows.push({ at, how: 'other', ...run(dirname(file), 'make', '--all', '--emit', 'node', file) })
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const tally = new Map<string, number>()
const hits: string[] = []
const failed: Row[] = []
let notProgram = 0
let onPurpose = 0
let built = 0

for (const row of rows) {
  for (const code of CODES) {
    if (row.output.includes(code)) {
      hits.push(`${code}  ${row.at}`)
    }
  }

  tally.set(row.how, (tally.get(row.how) ?? 0) + 1)

  if (row.code === 0) {
    built++
  } else if (/is not a program/.test(row.output)) {
    notProgram++
  } else if (REFUSED_ON_PURPOSE.some(p => p.test(row.at))) {
    onPurpose++
  } else {
    failed.push(row)
  }
}

console.log(`programs ${rows.length}: ${[...tally].map(([k, v]) => `${v} ${k}`).join(', ')}`)
console.log(`built ${built}, not a program ${notProgram}, refused on purpose ${onPurpose}, failed ${failed.length}`)
console.log(`census refusals (${CODES.join(', ')}): ${hits.length}`)

for (const hit of hits) {
  console.log(`  ${hit}`)
}

for (const row of failed) {
  const first = row.output.split('\n').filter(l => l.startsWith('✗')).slice(0, 2).join(' | ')
  console.log(`FAILED ${row.how} ${row.at}\n  ${first.slice(0, 200)}`)
}

process.exit(hits.length > 0 || failed.length > 0 ? 1 : 0)
