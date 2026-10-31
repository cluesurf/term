// EVERY UNIT KEY A COLD POOL BUILD ASKS IS BUILT ONCE (decision 088 of term/self-host/change/001-finish-self-host, item
// term-self-host-001-0477). A cycle's import answer (`<head>#unit`) had no owning job, so every importer the pool started
// together missed it and built it, and a cold @term/base build counted 574 to 578 units where 572 are distinct. The head's
// own job now builds it, flagged answer-as-import, and every importer waits on that job.
//
// Each build runs with an empty TERM_CACHE_HOME and every write into it traced, per thread, by a module handed to node
// with --import (worker threads inherit it). A unit key is the final name a stored answer is written or renamed to, so
// a key written twice is a unit built twice. Two corpora:
//   (a) a project of 16 files: a two-file cycle imported by 14 files the pool starts together
//   (b) a cold copy of @term/base at <dir>/deck/base, built AS the standard library (TERM_STDLIB at it, host/ beside it
//       holding the worker bundles, as task/term/incremental-bench.ts copyOf makes it), three times
//   (c) a three-file cycle entered from each member as the entry and through an importer of each (decision 090): one
//       name for the cycle, and the head's import answer is the key every importer reads
//   (d) a unit sixteen rule-stating files import (decision 093): its key with bodies built once, by its own job
// Each of (a) and (b) must write every key once, and count as built exactly the distinct answers it stored (a refusal is stored and
// never counted). The copy's count must be the same on every run.
// Run: npx tsx test/call/unit-pool-once.ts

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import { projectResolver } from '@term/call/code/make'
import { tempDir } from '../temp'
import { LINE, TERM } from './cli'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1500)}`)
  }
}

if (cpus().length <= 2) {
  console.log(`skip  the pool needs more than two cores, this machine has ${cpus().length}`)
  console.log('\nunit-pool-once: 0 pass, 0 fail')
  process.exit(0)
}

// the tracer: every write or rename into TERM_CACHE_HOME, with its thread, appended to TRACE_WRITES
const TRACER = `import fs from 'node:fs'
import { createRequire } from 'node:module'
import { threadId } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const cjs = require('node:fs')
const home = process.env.TERM_CACHE_HOME
const log = process.env.TRACE_WRITES
const append = fs.appendFileSync.bind(fs)
const note = (op, path) => {
  const text = String(path)
  if (home && log && text.startsWith(home)) append(log, threadId + ' ' + op + ' ' + text.slice(home.length + 1) + '\\n')
}
for (const target of [fs, cjs]) {
  for (const name of ['writeFileSync', 'renameSync', 'writeFile', 'rename']) {
    const original = target[name]
    if (typeof original !== 'function' || original.__traced) continue
    const wrapped = function (path, ...rest) {
      note(name, name.startsWith('rename') ? rest[0] : path)
      return original.call(this, path, ...rest)
    }
    wrapped.__traced = true
    try {
      target[name] = wrapped
    } catch {}
  }
}
require('node:module').syncBuiltinESMExports()
for (const name of ['writeFile', 'rename']) {
  const original = fs.promises[name]
  fs.promises[name] = function (path, ...rest) {
    note('promises.' + name, name === 'rename' ? rest[0] : path)
    return original.call(this, path, ...rest)
  }
}
`

const scratch = realpathSync(tempDir('term-unit-once-'))
const tracer = join(scratch, 'trace-writes.mjs')
writeFileSync(tracer, TRACER)

type Traced = {
  status: number | null
  out: string
  built: number | null
  // each unit key's writes: a temporary name renamed onto the key counts once, as a write of the key
  writes: Map<string, number>
  // the answers the store holds, a refusal apart
  answers: number
  refused: number
}

const walkFiles = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out

  for (const name of readdirSync(dir)) {
    const at = join(dir, name)

    if (statSync(at).isDirectory()) walkFiles(at, out)
    else out.push(at)
  }

  return out
}

function traced(root: string, home: string, env: Record<string, string>, args: string[]): Traced {
  const log = join(scratch, `writes-${Math.random().toString(16).slice(2)}.log`)
  writeFileSync(log, '')
  const ran = spawnSync(
    process.execPath,
    ['--import', tracer, LINE, 'make', '--no-motion', '--color', 'never', '--plain', ...args],
    {
      cwd: root,
      env: { ...process.env, ...env, TERM_CACHE_HOME: home, TRACE_WRITES: log },
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    },
  )
  const out = `${ran.stdout}\n${ran.stderr}`
  const found = /([\d,]+) units? built/.exec(out)
  const writes = new Map<string, number>()

  for (const line of readFileSync(log, 'utf8').split('\n')) {
    const [, op, path] = line.split(' ')

    if (!path || !path.startsWith('unit/') || !path.endsWith('.json.gz')) continue
    if (!op!.startsWith('rename') && !op!.startsWith('promises.rename') && /\.tmp$/.test(path)) continue

    writes.set(path, (writes.get(path) ?? 0) + 1)
  }

  let answers = 0
  let refused = 0

  for (const file of walkFiles(join(home, 'unit'))) {
    if (!file.endsWith('.json.gz')) continue

    const text = gunzipSync(readFileSync(file)).toString('utf8')

    // a name pointer (`surface:`) holds a key alone, an answer its stored entry
    if (text.length < 200) continue
    if (text.includes('{\\"diagnostics\\"')) refused++
    else answers++
  }

  return {
    status: ran.status,
    out,
    built: found ? Number(found[1]!.replace(/,/g, '')) : null,
    writes,
    answers,
    refused,
  }
}

const twice = (run: Traced): string[] =>
  [...run.writes].filter(([, n]) => n > 1).map(([key, n]) => `${key} x${n}`)

function holds(name: string, run: Traced): void {
  const more = twice(run)
  ok(`${name}: the build reports its units`, run.built !== null, run.out.slice(-2000))
  ok(`${name}: every unit key written once (${run.writes.size} keys)`, more.length === 0, more.join(', '))
  ok(
    `${name}: built ${run.built} is the distinct answers stored (${run.answers}, ${run.refused} refused apart)`,
    run.built === run.answers,
    run.out.slice(-1500),
  )
}

// (a) a two-file cycle, imported by 14 files that start together once it is built
{
  const root = join(scratch, 'cycle')
  mkdirSync(join(root, 'code', 'cycle'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), 'deck @probe/unit-pool-once\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(
    join(root, 'code/cycle/a.tree'),
    'load ./b\n  find bee\n\ntask ay\n  take x, like number\n  like number\n  back bee(add(x, 1))\n',
  )
  writeFileSync(
    join(root, 'code/cycle/b.tree'),
    'load ./a\n  find ay\n\ntask bee\n  take x, like number\n  like number\n  back multiply(x, 2)\n',
  )

  for (let n = 1; n <= 14; n++) {
    writeFileSync(
      join(root, `code/use-${n}.tree`),
      `load ./cycle/a\n  find ay\n\ntask use-${n}\n  take x, like number\n  like number\n  back ay(add(x, ${n}))\n`,
    )
  }

  const run = traced(root, join(scratch, 'cycle-home'), {}, [])
  ok('cycle: the build exits 0', run.status === 0, run.out.slice(-2000))
  ok('cycle: the pool ran', /pool|worker/i.test(run.out), run.out.slice(-2000))
  holds('cycle', run)
}

// (d) A UNIT A RULE REACHES IS BUILT UNDER PROOF BY ITS OWN JOB (decision 093): a shared form and sixteen files that each
// state a rule over it. Each rule-stating walk asks the shared unit under its key with bodies, which the shared unit's
// own walk never asks, so before 093 the jobs started together each built it (built 27 over 20 answers). The shared unit
// loads part of the standard library, so every worker is started and idle by the time it is built
{
  const root = join(scratch, 'proof')
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), 'deck @probe/unit-proof-once\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(join(root, 'code/shared.tree'), 'load @term/base/text\n  find trim\n\nform token\n  head a\n  case mark\n    link value, like a\n')

  for (let n = 1; n <= 16; n++) {
    writeFileSync(
      join(root, `code/keep-${n}.tree`),
      `load ./shared\n  find token\n\nrule keeps-${n}\n  head a\n  take x, like a\n  like token a\n\ntask keeps-${n}\n  take x\n  send back\n    make token/mark\n      bind value, read x\n`,
    )
  }

  const run = traced(root, join(scratch, 'proof-home'), {}, [])
  ok('proof: the build exits 0', run.status === 0, run.out.slice(-2000))
  ok('proof: the pool ran', /pool|worker|parallel/i.test(run.out), run.out.slice(-2000))
  holds('proof', run)
}

// (c) ONE CYCLE, ONE NAME, ONE KEY (decision 090): a three-file cycle x -> y -> z -> x entered from each member, as the
// entry and through an importer of that member, in process against one store. Every walk names the cycle by its sorted
// members, and the import answer the head builds (answerAsImport) is the key every importer reads
{
  const root = join(scratch, 'enter')
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), 'deck @probe/unit-enter\n  mark <0.0.1>\n')
  const at = (name: string): string => join(root, 'code', `${name}.tree`)
  const next: Record<string, string> = { x: 'y', y: 'z', z: 'x' }
  const texts = new Map<string, string>()

  for (const [m, n] of Object.entries(next)) {
    texts.set(m, `load ./${n}\n  find task-${n}\n\ntask task-${m}\n  take k, like number\n  like number\n  back k\n`)
    texts.set(`i${m}`, `load ./${m}\n  find task-${m}\n\ntask use-${m}\n  like number\n  back task-${m}(1)\n`)
  }

  for (const [name, text] of texts) writeFileSync(at(name), text)

  const short = (label: string): string => label.split('+').map(one => one.replace(/^.*\/code\//, '')).join('+')
  const build = (cache: CompileCache, name: string, asImport = false) => {
    const result = compileSeparate(
      { file: at(name), text: texts.get(name)! },
      { resolve: projectResolver(root), cache, modules: f => `./${f}`, answerAsImport: asImport },
    )

    if (!result.ok) return { ok: false, why: result.diagnostics.map(d => d.message).join(' | '), built: [] as string[], seen: [] as string[] }

    const built = result.built.map(short)

    return { ok: true, why: '', built, seen: [...built, ...result.reused.map(short)] }
  }
  const cycleOf = (seen: string[]): string[] => [...new Set(seen.filter(label => label.includes('+')))]

  // one name, whichever member or importer the walk starts from, each on a store of its own
  const names = new Set<string>()

  for (const name of ['x', 'y', 'z', 'ix', 'iy', 'iz']) {
    const run = build(new CompileCache(), name)
    ok(`enter at ${name}: builds`, run.ok, run.why)
    for (const label of cycleOf(run.seen)) names.add(label)
  }

  ok(`one name for the cycle from all six starts (${[...names].join(', ')})`, names.size === 1 && names.has('x.tree+y.tree+z.tree'), [...names].join(', '))

  // one key: the head's job builds the import answer, and an importer of every member then builds only itself
  const shared = new CompileCache()
  const head = build(shared, 'x', true)
  ok('the head x, asked answer-as-import, builds the cycle as entry and as import', head.built.filter(label => label === 'x.tree+y.tree+z.tree').length === 2, head.built.join(', '))

  for (const name of ['ix', 'iy', 'iz']) {
    const run = build(shared, name)
    ok(`${name} reads the head's import answer and builds only itself`, run.ok && run.built.length === 1 && run.built[0] === `${name}.tree`, run.built.join(', ') || run.why)
  }
}

// (b) a cold copy of @term/base built as the standard library, three times, each on a fresh copy and an empty home
{
  const source = join(TERM, 'deck', 'base')
  const counts: (number | null)[] = []

  for (let i = 1; i <= 3; i++) {
    const into = join(scratch, `base-${i}`)
    mkdirSync(join(into, 'host'), { recursive: true })

    for (const bundle of ['separate-worker.mjs', 'build-worker.mjs']) {
      cpSync(join(TERM, 'host', bundle), join(into, 'host', bundle))
    }

    const at = join(into, 'deck', 'base')
    mkdirSync(at, { recursive: true })

    for (const part of ['deck.tree', 'role.tree', 'role', 'code', 'test', 'test.tree']) {
      if (existsSync(join(source, part))) cpSync(join(source, part), join(at, part), { recursive: true })
    }

    const root = realpathSync(at)
    const run = traced(root, join(scratch, `base-${i}-home`), { TERM_STDLIB: root }, ['--trees'])
    counts.push(run.built)
    holds(`@term/base cold run ${i}`, run)
  }

  ok(
    `@term/base: the same count on every cold run (${counts.join(', ')})`,
    counts.every(count => count !== null && count === counts[0]),
  )
}

console.log(`\nunit-pool-once: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
