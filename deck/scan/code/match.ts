// Decide whether an installed version is affected by an advisory, and choose the lowest safe upgrade. This is the
// heart of the Dependabot-equivalent: the vulnerable-version-range match. An advisory affects a version when ANY of
// its three vulnerable-version forms matches (structured ranges, explicit versions, or an npm range expression).

import type { Advisory, AdvisoryRange } from './form'
import { compareVersion, satisfies, toCode } from './semver'

// is `version` inside one structured window? `introduced <= v` and (`v < fixed` or no fixed) and
// (`v <= lastAffected` or no lastAffected). An absent/`0` introduced means "from the beginning".
function inRange(version: string, range: AdvisoryRange): boolean {
  const introduced = range.introduced ?? '0'

  if (introduced !== '0' && compareVersion(version, introduced) < 0) {
    return false
  }

  if (range.fixed !== undefined) {
    if (compareVersion(version, range.fixed) >= 0) {
      return false
    }
  }

  if (range.lastAffected !== undefined) {
    if (compareVersion(version, range.lastAffected) > 0) {
      return false
    }
  }

  return true
}

// is an installed `version` affected by `advisory`?
export function isAffected(version: string, advisory: Advisory): boolean {
  // an unparseable version cannot be soundly matched against structured ranges; only an exact-string listing can
  const parsed = toCode(version)

  if (advisory.versions && advisory.versions.includes(version)) {
    return true
  }

  if (parsed) {
    for (const range of advisory.ranges) {
      if (inRange(version, range)) {
        return true
      }
    }
  }

  if (advisory.rangeExpression) {
    if (satisfies(version, advisory.rangeExpression)) {
      return true
    }
  }

  return false
}

// the set of known fixed versions for an advisory: the explicit `fixedVersions`, plus every range's `fixed`
// boundary (the first non-vulnerable version of that window).
export function fixedVersionsOf(advisory: Advisory): string[] {
  const out = new Set<string>(advisory.fixedVersions ?? [])

  for (const range of advisory.ranges) {
    if (range.fixed) {
      out.add(range.fixed)
    }
  }

  return [...out]
}

// choose the lowest version that clears EVERY advisory affecting a package. Candidates are the advisories' known
// fixed versions; the winner is the smallest candidate that no advisory still marks affected. Returns undefined
// when no candidate is known (e.g. an advisory with no fixed version) or none is safe.
export function planUpgrade(
  currentVersion: string,
  advisories: Advisory[],
): string | undefined {
  const candidates = new Set<string>()

  for (const advisory of advisories) {
    for (const fixed of fixedVersionsOf(advisory)) {
      // only consider upgrades (strictly newer than what is installed)
      if (compareVersion(fixed, currentVersion) > 0) {
        candidates.add(fixed)
      }
    }
  }

  const sorted = [...candidates].sort(compareVersion)

  for (const candidate of sorted) {
    const stillVulnerable = advisories.some(a =>
      isAffected(candidate, a),
    )

    if (!stillVulnerable) {
      return candidate
    }
  }

  return undefined
}
