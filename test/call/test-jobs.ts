// `term test --jobs N` (decision 022 T5, item 0158). A project of six test files that each wait a second: run one at a
// time they take six seconds at least, and four at once they finish in under three quarters of that, with the same counts per file. The
// seconds each file took are kept in the project's cache, and the next run orders by them: a file never timed first,
// then the longest, then by path.
// Run: npx tsx test/call/test-jobs.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tempDir } from '../temp'
import { LINE } from './cli'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const root = realpathSync(tempDir('test-jobs-'))
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/jobs\n  mark <0.0.1>\n`)
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f']
for (const name of NAMES) {
  writeFileSync(
    join(root, 'test', `${name}.tree`),
    `load @term/base/clock\n  find sleep\n\ntest <${name} waits a second>\n  sleep(1000)\n  want hold, true\n\ntest <${name} holds>\n  want hold, is-equal(1, 1)\n`,
  )
}

type Item = { kind?: string; verb?: string; subject?: string; counts?: Record<string, number> }

const run = (...args: string[]): { code: number | null; out: string; ms: number; items: Item[] } => {
  const started = Date.now()
  const ran = spawnSync('node', [LINE, 'test', ...args, '--log', 'json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
  })
  const ms = Date.now() - started
  const out = `${ran.stdout}${ran.stderr}`
  const items: Item[] = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      items.push(JSON.parse(line) as Item)
    } catch {
      // a line that is not an item
    }
  }

  return { code: ran.status, out, ms, items }
}

// each file's item: `<subject> <counts>`, sorted
const perFile = (items: Item[]): string[] =>
  items
    .filter(item => item.kind === 'step' && item.verb === 'test')
    .map(item => `${item.subject} ${JSON.stringify(item.counts)}`)
    .sort()

const files = (items: Item[]): string[] =>
  items.filter(item => item.kind === 'step' && item.verb === 'test').map(item => String(item.subject))

// a first run builds every file, so the runs measured after it read the bundles from the cache
const warm = run('--jobs', '4')
ok('the first run passes', warm.code === 0, warm.out)

const one = run('--jobs', '1')
const four = run('--jobs', '4')
ok('one at a time passes', one.code === 0, one.out)
ok('four at once passes', four.code === 0, four.out)
ok(`one at a time takes six seconds at least (${one.ms} ms)`, one.ms >= 6000)
// relative to the run at one job, never a wall-clock bound: on a loaded machine both runs slow down together, and a
// fixed 4000 ms failed at 4283 ms in the 2026-11-08 queue trial with the runs overlapping as they should
ok(`four at once takes under three quarters of one at a time (${four.ms} ms against ${one.ms} ms)`, four.ms < one.ms * 0.75)
ok(
  'per-file counts are equal at one and at four',
  perFile(one.items).length === NAMES.length && perFile(one.items).join('\n') === perFile(four.items).join('\n'),
  `${perFile(one.items).join(' | ')} against ${perFile(four.items).join(' | ')}`,
)
const close = (items: Item[]): string => JSON.stringify(items.find(item => item.kind === 'close')?.counts)
ok('the totals are equal at one and at four', close(one.items) === close(four.items) && close(one.items) !== undefined, `${close(one.items)} against ${close(four.items)}`)

// the seconds of every file, kept for node
const seconds = join(root, '.base', '@term', 'code', 'cache', 'test', 'seconds.json')
const kept = existsSync(seconds) ? (JSON.parse(readFileSync(seconds, 'utf8')) as Record<string, Record<string, number>>) : {}
ok(
  'each file has its seconds kept for node',
  NAMES.every(name => (kept.node?.[`test/${name}.tree`] ?? 0) >= 1),
  JSON.stringify(kept),
)

// the order: a file never timed first, then the longest, then by path. One at a time, items come in run order
kept.node = { ...(kept.node ?? {}), 'test/d.tree': 30 }
mkdirSync(dirname(seconds), { recursive: true })
writeFileSync(seconds, JSON.stringify(kept))
writeFileSync(join(root, 'test', 'g.tree'), `test <g is new>\n  want hold, true\n`)
const ordered = run('--jobs', '1')
const order = files(ordered.items)
ok(
  'a file never timed runs first, then the longest',
  order[0] === 'test/g.tree' && order[1] === 'test/d.tree',
  order.join(' '),
)

// a `--jobs` that is no number is the default
const strange = run('--jobs', 'many')
ok('a --jobs that is no number runs at the default', strange.code === 0 && files(strange.items).length === NAMES.length + 1, strange.out)

console.log(`\ntest-jobs: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
