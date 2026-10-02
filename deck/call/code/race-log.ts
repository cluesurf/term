// The race log (note/term/optimize/learning.md, optimize-0013): every measurement `term race` and `term bake` take,
// including every loss and every disagreement, one record each, kept so the next bake reads an answer instead of
// measuring it again (level one, optimize-0028) and so a ranker can learn from all of them (optimize-0029).
//
// Stored under the project's `.base/@cluesurf/term/race/v1/<shard>/<id>.json.gz` (the path through home.ts, like every
// other on-disk path). An id, a region and a rule digest are sha256 digests shown in the 8x8 tone shape, never hex and
// never truncated. A record is never rewritten: a new measurement is a new record.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { projectHome } from './home'
import { dashInEights, hexToTone } from '../../deck/code/object/tone'

// the shape a record is stored in. A change to it is a new version directory, never an edit of old records
export const RACE_VERSION = 'v1'

export type RaceFacts = {
  // the element type, when the inputs are lists
  element?: string
  // each list parameter's size, bucketed to a power of four
  size: Record<string, number>
  // the share of distinct values, to the tenth
  distinct_ratio?: number
  sorted?: 'yes' | 'no' | 'unknown'
  range?: [number, number]
  pure: 'yes' | 'no'
}

export type RaceTarget = {
  backend: string
  toolchain: string
  machine: string
  cores: number
  power?: string
}

export type RaceRecord = {
  id: string
  // the normalized region raced, as a sha256 in tone
  region: string
  facts: RaceFacts
  target: RaceTarget
  compiler: string
  // the digest of every admitted twin and bend the build could see
  rules: string
  candidate: { task: string; twin: string; knob: Record<string, number>; step: string[] }
  admission: 'proven' | 'tested' | 'trusted' | 'reference'
  // what happened: a measurement, a loss to another candidate, a disagreement, or a run that hit its limit
  result: 'measured' | 'lost' | 'disagreed' | 'timed-out'
  time_ns?: { median: number; mad: number; low: number; high: number; samples: number }
  memory_peak?: number
  size?: number
  taken: string
}

// sha256 of a value's stable JSON, in the 8x8 tone shape
export function toneDigest(value: unknown): string {
  return dashInEights(hexToTone(createHash('sha256').update(stable(value)).digest('hex')))
}

// JSON with object keys sorted, so the same value always hashes the same
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

// the bucket a size falls in: the power of four at or below it, so runs that differ by noise share a key
export function sizeBucket(size: number): number {
  return size <= 0 ? 0 : 4 ** Math.floor(Math.log(size) / Math.log(4))
}

export function ratioBucket(ratio: number): number {
  return Math.round(ratio * 10) / 10
}

const dirOf = (root: string): string => projectHome(root, 'race', RACE_VERSION)

// store a record, giving it its id. Returns the record as stored
export function writeRace(root: string, record: Omit<RaceRecord, 'id'>): RaceRecord {
  const stored: RaceRecord = { id: toneDigest(record), ...record }
  const shard = join(dirOf(root), stored.id.slice(0, 2))

  mkdirSync(shard, { recursive: true })
  writeFileSync(join(shard, `${stored.id}.json.gz`), gzipSync(JSON.stringify(stored)))

  return stored
}

// every record, or those a predicate keeps
export function readRaces(root: string, keep: (record: RaceRecord) => boolean = () => true): RaceRecord[] {
  const dir = dirOf(root)

  if (!existsSync(dir)) {
    return []
  }

  const out: RaceRecord[] = []

  for (const shard of readdirSync(dir)) {
    for (const file of readdirSync(join(dir, shard))) {
      if (!file.endsWith('.json.gz')) {
        continue
      }

      try {
        const record = JSON.parse(gunzipSync(readFileSync(join(dir, shard, file))).toString('utf8')) as RaceRecord

        if (keep(record)) {
          out.push(record)
        }
      } catch {
        // an unreadable record is skipped, never trusted
      }
    }
  }

  return out
}

// LEVEL ONE (optimize-0028): the measurement of this candidate on this region, under the same bucketed facts, on the
// same target, under the same rules and compiler, if there is one. A different compiler or rule digest is a miss, and
// the old record stays as history without being used as an answer
export function lookupRace(
  root: string,
  ask: { region: string; facts: RaceFacts; target: RaceTarget; compiler: string; rules: string; task: string; twin: string },
): RaceRecord | undefined {
  const facts = stable(ask.facts)
  const target = stable(ask.target)

  return readRaces(
    root,
    r =>
      r.result === 'measured' &&
      r.region === ask.region &&
      r.compiler === ask.compiler &&
      r.rules === ask.rules &&
      r.candidate.task === ask.task &&
      r.candidate.twin === ask.twin &&
      stable(r.facts) === facts &&
      stable(r.target) === target,
  ).sort((a, b) => b.taken.localeCompare(a.taken))[0]
}
