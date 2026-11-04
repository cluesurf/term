// Build every program of a kept census corpus with one compiler and print each refusal with the suites that built it
// (decision 096 rule 8 of note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0508).
//
// The corpus is harvested by one `pnpm term:test --fresh` run with TERM_CENSUS_KEEP=<dir> set (task/term/test.ts,
// task/term/census-keep.cjs): <dir>/<hash>/tree/ holds one program's `.tree` files, suite.txt each suite that built
// it, origin.txt how. Each program is built here with `term make --all` run from its folder (check and the TypeScript
// emit, no native toolchain), so a census of a checker change reads every Term program a gate compiles, where a census
// of the packages' `.tree` files misses the programs written inside test/**/*.ts. Tests also build programs meant to
// be refused (a checker test's negative cases), so a census is read against a baseline: run it once on the live
// compiler with --write <file>, then with the window's compiler and --against <file>, which prints only what is new.
//
// Limit: a program is built with the default resolver and the node env. A test that pinned `{platform}` to another
// host, or served modules from memory under a path its resolver alone knows, is built here as the plain project would
// be, so its line can differ from what the test saw; the baseline holds that difference on both sides.
//
//   npx tsx task/term/census-corpus.ts <corpus dir> [--line <host/line.js>] [--jobs N] [--write <file>]
//     [--against <file>] [--only <suite substring>]

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { CALLER_CWD, TERM_ROOT } from './root'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const corpus = args[0] !== undefined && !args[0].startsWith('--') ? resolve(CALLER_CWD, args[0]) : ''

if (corpus === '' || !existsSync(corpus)) {
  console.error('usage: census-corpus.ts <corpus dir> [--line <line.js>] [--jobs N] [--write <file>] [--against <file>] [--only <suite>]')
  process.exit(2)
}

const TERM = TERM_ROOT
const line = resolve(flag('--line') ?? join(TERM, 'host/line.js'))
const jobs = Math.max(1, Number(flag('--jobs') ?? Math.max(1, Math.min(8, cpus().length - 1))))
const only = flag('--only') ?? ''
const writeTo = flag('--write')
const against = flag('--against')

type Kept = { hash: string; suites: string[]; origin: string }

const kept: Kept[] = readdirSync(corpus)
  .filter(hash => existsSync(join(corpus, hash, 'tree')))
  .sort()
  .map(hash => ({
    hash,
    suites: readFileSync(join(corpus, hash, 'suite.txt'), 'utf8').split('\n').filter(s => s !== ''),
    origin: existsSync(join(corpus, hash, 'origin.txt'))
      ? readFileSync(join(corpus, hash, 'origin.txt'), 'utf8').trim()
      : '',
  }))
  .filter(program => only === '' || program.suites.some(suite => suite.includes(only)))

// one refusal: the program, its code, its place (relative to the program), and the first line of its message
type Refusal = { hash: string; code: string; place: string; message: string }

function refusals(hash: string, output: string): Refusal[] {
  const found: Refusal[] = []
  const lines = output.split('\n')

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('✗ check ')) {
      continue
    }

    // the message wraps over several lines, the code last, up to the `file` line
    let text = lines[i]!.slice('✗ check '.length)
    let place = ''

    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const at = /^\s+file (\S+)/.exec(lines[j]!)

      if (at !== null) {
        place = at[1]!.replace(/^.*\/tree\//, '')
        break
      }

      if (/^\S/.test(lines[j]!)) {
        break
      }

      text += ` ${lines[j]!.trim()}`
    }

    const code = /\s([a-z][a-z0-9]*(?:-[a-z0-9]+)+|[a-z]+)\s*$/.exec(text)

    found.push({
      hash,
      code: code?.[1] ?? 'unknown',
      place,
      message: text.slice(0, code?.index ?? text.length).slice(0, 160),
    })
  }

  return found
}

function build(program: Kept): Promise<{ program: Kept; found: Refusal[]; status: number | null }> {
  return new Promise(done => {
    const run = spawn(process.execPath, [line, 'make', '--all'], {
      cwd: join(corpus, program.hash, 'tree'),
      env: { ...process.env, TERM_CENSUS_KEEP: '', NO_COLOR: '1' },
    })
    let output = ''

    run.stdout.on('data', chunk => (output += String(chunk)))
    run.stderr.on('data', chunk => (output += String(chunk)))
    run.on('close', status => done({ program, found: refusals(program.hash, output), status }))
  })
}

const key = (refusal: Refusal): string => `${refusal.hash}\t${refusal.code}\t${refusal.place}`
const baseline = new Set(
  against !== undefined && existsSync(against)
    ? readFileSync(against, 'utf8').split('\n').filter(l => l !== '').map(l => l.split('\t').slice(0, 3).join('\t'))
    : [],
)

const started = Date.now()
const all: Refusal[] = []
const bySuite = new Map<string, number>()
let next = 0
let refused = 0

async function worker(): Promise<void> {
  while (next < kept.length) {
    const program = kept[next++]!
    const { found } = await build(program)

    for (const refusal of found) {
      all.push(refusal)

      if (against !== undefined && baseline.has(key(refusal))) {
        continue
      }

      for (const suite of program.suites) {
        bySuite.set(suite, (bySuite.get(suite) ?? 0) + 1)
      }

      console.log(`${refusal.code}\t${program.suites.join(', ')}\t${refusal.hash}/${refusal.place}\t${refusal.message}`)
    }

    if (found.length > 0) {
      refused++
    }
  }
}

async function main(): Promise<void> {
  await Promise.all(Array.from({ length: jobs }, worker))
  finish()
}

function finish(): void {
  if (writeTo !== undefined) {
    writeFileSync(
      writeTo,
      all
        .map(r => `${key(r)}\t${r.message}`)
        .sort()
        .join('\n') + '\n',
    )
  }

  const shown = against !== undefined ? [...bySuite.values()].reduce((a, b) => a + b, 0) : all.length
  const suites = new Set(kept.flatMap(program => program.suites))

  console.log(
    `\ncensus-corpus: ${kept.length} programs from ${suites.size} suites, ${refused} refused, ${all.length} refusals` +
      (against !== undefined ? `, ${shown} new against ${against}` : '') +
      `, ${Math.round((Date.now() - started) / 1000)}s with ${jobs} jobs (${line})`,
  )

  for (const [suite, count] of [...bySuite].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${String(count).padStart(5)}  ${suite}`)
  }

  process.exit(against !== undefined && shown > 0 ? 1 : 0)
}

void main()
