// The race log (deck/call/code/race-log.ts, optimize-0013): records are written under the project's .base, read
// back whole, keyed so that noise does not split one measurement into many, and a lookup answers only under the same
// region, facts, target, compiler and rules (level one of note/term/optimize/learning.md).
// Run: npx tsx test/call/race-log.ts

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookupRace, ratioBucket, readRaces, sizeBucket, toneDigest, writeRace } from '../../deck/call/code/race-log'
import type { RaceRecord } from '../../deck/call/code/race-log'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'race-log-'))
const region = toneDigest({ task: 'count-each', at: 'code/stats.tree', ordinal: 0 })
const rules = toneDigest(['count-each/tally', 'count-each/dense'])
const facts = { element: 'number', size: { values: sizeBucket(1100), queries: sizeBucket(1030) }, distinct_ratio: ratioBucket(0.31), sorted: 'no' as const, pure: 'yes' as const }
const target = { backend: 'rust', toolchain: 'rustc 1.83.0', machine: 'apple-m3/aarch64/macos-26', cores: 8 }

const record: Omit<RaceRecord, 'id'> = {
  region,
  facts,
  target,
  compiler: '0.9.12',
  rules,
  candidate: { task: 'count-each', twin: 'tally', knob: {}, step: ['twin count-each tally'] },
  admission: 'tested',
  result: 'measured',
  time_ns: { median: 38200, mad: 410, low: 37600, high: 39000, samples: 40 },
  taken: '2026-10-02T14:03:11Z',
}

const stored = writeRace(root, record)

ok('an id is a sha256 in the 8x8 tone shape', /^[mndbtkhsfvzxcwlr]{8}(-[mndbtkhsfvzxcwlr]{8}){7}$/.test(stored.id), stored.id)
ok('a region and a rule digest are too', /^([a-z]{8}-){7}[a-z]{8}$/.test(region) && /^([a-z]{8}-){7}[a-z]{8}$/.test(rules))
ok('the record lives under .base/@term/code/race/v1, in a shard', readdirSync(join(root, '.base/@term/code/race/v1')).length === 1)
ok('it reads back whole', JSON.stringify(readRaces(root)[0]) === JSON.stringify(stored))
ok('the same record is the same id', writeRace(root, record).id === stored.id)

ok('sizes that differ by noise share a bucket', sizeBucket(1100) === sizeBucket(1030) && sizeBucket(1100) === 1024)
ok('sizes a power of four apart do not', sizeBucket(1100) !== sizeBucket(4500))
ok('ratios are bucketed to the tenth', ratioBucket(0.31) === ratioBucket(0.28) && ratioBucket(0.31) !== ratioBucket(0.41))

const ask = { region, facts, target, compiler: '0.9.12', rules, task: 'count-each', twin: 'tally' }

ok('a lookup under the same everything answers', lookupRace(root, ask)?.id === stored.id)
ok('a different compiler is a miss', lookupRace(root, { ...ask, compiler: '0.9.14' }) === undefined)
ok('a different rule digest is a miss', lookupRace(root, { ...ask, rules: toneDigest(['count-each/tally']) }) === undefined)
ok('a different machine is a miss', lookupRace(root, { ...ask, target: { ...target, machine: 'intel/x86_64/linux' } }) === undefined)
ok('a different twin is a miss', lookupRace(root, { ...ask, twin: 'dense' }) === undefined)

// a disagreement is kept, and never answers a lookup
writeRace(root, { ...record, candidate: { ...record.candidate, twin: 'skips-first' }, result: 'disagreed', time_ns: undefined, taken: '2026-10-02T15:00:00Z' })
ok('a disagreement is kept in the log', readRaces(root, r => r.result === 'disagreed').length === 1)
ok('and never answers a lookup', lookupRace(root, { ...ask, twin: 'skips-first' }) === undefined)

console.log(`\nrace-log: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
