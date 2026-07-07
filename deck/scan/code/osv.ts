// Import OSV records (https://ossf.github.io/osv-schema/) into our `Advisory` model. OSV is the lingua franca of
// vulnerability data: OSV.dev, the GitHub Advisory Database, and most language ecosystems publish it, and its schema
// maps a vulnerability to affected package versions or commit ranges. We read the parts that matter for version
// matching (affected packages, SEMVER/ECOSYSTEM ranges, explicit versions) and severity.

import type { Advisory, AdvisoryRange, Severity } from './form'
import { toRegistryName } from '@cluesurf/deck.tree'

// the slice of the OSV schema we consume. Extra fields are ignored.
export type OsvRecord = {
  id: string
  aliases?: string[]
  summary?: string
  details?: string
  severity?: { type: string; score: string }[]
  affected?: {
    package?: { ecosystem?: string; name?: string }
    ranges?: {
      type?: string
      events?: {
        introduced?: string
        fixed?: string
        last_affected?: string
      }[]
    }[]
    versions?: string[]
  }[]
  references?: { type?: string; url?: string }[]
  database_specific?: { severity?: string }
}

// map an OSV / GHSA textual severity, or a CVSS base score, to our severity vocabulary.
function toSeverity(record: OsvRecord): Severity {
  const text = record.database_specific?.severity?.toLowerCase()

  if (text === 'critical') {
    return 'critical'
  }

  if (text === 'high') {
    return 'high'
  }

  if (text === 'moderate' || text === 'medium') {
    return 'moderate'
  }

  if (text === 'low') {
    return 'low'
  }

  // fall back to a CVSS base score if present
  const cvss = record.severity?.find(s => s.type.startsWith('CVSS'))

  if (cvss) {
    const score = cvssBaseScore(cvss.score)

    if (score !== undefined) {
      if (score >= 9) {
        return 'critical'
      }

      if (score >= 7) {
        return 'high'
      }

      if (score >= 4) {
        return 'moderate'
      }

      return 'low'
    }
  }

  return 'moderate'
}

// pull the numeric base score out of a CVSS vector string if it carries one, else undefined. A bare number is also
// accepted. We do not evaluate the vector (that needs the full CVSS calculator); scores are only used as a coarse
// fallback when no textual severity is given.
function cvssBaseScore(score: string): number | undefined {
  const asNumber = Number(score)

  if (!Number.isNaN(asNumber)) {
    return asNumber
  }

  return undefined
}

// convert OSV range events into our structured windows. OSV lists events in order; each `introduced` opens a window
// that the next `fixed` / `last_affected` closes. GIT ranges are skipped (we match on versions, not commits).
function toRanges(record: OsvRecord, ecosystem: string): AdvisoryRange[] {
  const out: AdvisoryRange[] = []

  for (const affected of record.affected ?? []) {
    if (!matchesEcosystem(affected.package?.ecosystem, ecosystem)) {
      continue
    }

    for (const range of affected.ranges ?? []) {
      if (range.type === 'GIT') {
        continue
      }

      let current: AdvisoryRange | undefined

      for (const event of range.events ?? []) {
        if (event.introduced !== undefined) {
          if (current) {
            out.push(current)
          }

          current = {
            introduced:
              event.introduced === '0' ? undefined : event.introduced,
          }
        } else if (event.fixed !== undefined) {
          current = { ...(current ?? {}), fixed: event.fixed }
          out.push(current)
          current = undefined
        } else if (event.last_affected !== undefined) {
          current = {
            ...(current ?? {}),
            lastAffected: event.last_affected,
          }
          out.push(current)
          current = undefined
        }
      }

      if (current) {
        out.push(current)
      }
    }
  }

  return out
}

function toVersions(
  record: OsvRecord,
  ecosystem: string,
): string[] | undefined {
  const versions: string[] = []

  for (const affected of record.affected ?? []) {
    if (!matchesEcosystem(affected.package?.ecosystem, ecosystem)) {
      continue
    }

    versions.push(...(affected.versions ?? []))
  }

  return versions.length ? versions : undefined
}

// OSV ecosystem names are case-sensitive strings (e.g. "npm", "PyPI"). We compare case-insensitively and treat a
// missing ecosystem as a match (some private feeds omit it).
function matchesEcosystem(
  actual: string | undefined,
  wanted: string,
): boolean {
  if (!actual) {
    return true
  }

  return actual.toLowerCase() === wanted.toLowerCase()
}

// the package name an OSV record targets, mapped to our registry name (with `.tree`). Returns undefined when the
// record has no package in the requested ecosystem.
function packageNameOf(
  record: OsvRecord,
  ecosystem: string,
): string | undefined {
  for (const affected of record.affected ?? []) {
    if (!matchesEcosystem(affected.package?.ecosystem, ecosystem)) {
      continue
    }

    const name = affected.package?.name

    if (name) {
      return toRegistryName({ name })
    }
  }

  return undefined
}

// convert one OSV record into an Advisory, or undefined if it does not affect a package in `ecosystem`. The
// ecosystem defaults to `term` (our registry); pass `npm` to consume npm advisories for JS dependencies.
export function fromOsv(
  record: OsvRecord,
  ecosystem = 'term',
): Advisory | undefined {
  const packageName = packageNameOf(record, ecosystem)

  if (!packageName) {
    return undefined
  }

  const references = (record.references ?? [])
    .map(r => r.url)
    .filter((u): u is string => Boolean(u))

  return {
    id: record.id,
    packageName,
    severity: toSeverity(record),
    title: record.summary ?? record.details?.slice(0, 120) ?? record.id,
    url:
      references.find(u => u.includes('advisories') || u.includes('CVE')) ??
      references[0] ??
      `https://osv.dev/vulnerability/${record.id}`,
    ranges: toRanges(record, ecosystem),
    versions: toVersions(record, ecosystem),
    fixedVersions: toRanges(record, ecosystem)
      .map(r => r.fixed)
      .filter((v): v is string => Boolean(v)),
    aliases: record.aliases,
    references,
  }
}

// import a whole OSV feed (an array of records, or a single record) into advisories for one ecosystem.
export function fromOsvFeed(
  data: unknown,
  ecosystem = 'term',
): Advisory[] {
  const records: OsvRecord[] = Array.isArray(data)
    ? (data as OsvRecord[])
    : [data as OsvRecord]

  const out: Advisory[] = []

  for (const record of records) {
    if (!record || typeof record !== 'object' || !record.id) {
      continue
    }

    const advisory = fromOsv(record, ecosystem)

    if (advisory) {
      out.push(advisory)
    }
  }

  return out
}
