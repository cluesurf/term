// Advisory sources: where known-vulnerability data comes from. Three are built in, mirroring how a real audit
// pipeline blends feeds:
//   - a LOCAL database directory of advisory files (our own advisories, or a mirror of OSV / GitHub Advisory
//     Database records), so an air-gapped or custom-ecosystem project still gets alerts
//   - an OSV FEED file (the open OSV export, for one ecosystem)
//   - the REGISTRY bulk service (the npm-compatible advisory endpoint the package manager already speaks),
//     degrading to "unavailable" when the registry has none
// A source gathers advisories relevant to a set of dependency nodes; the audit engine then matches versions.

import fsp from 'fs/promises'
import path from 'path'
import type { Advisory, DependencyNode, Severity } from './form'
import { fromOsvFeed } from './osv'
import type { OsvRecord } from './osv'
import {
  auditDependencies as registryAudit,
  toRegistryName,
} from '@cluesurf/deck.tree'

export type AdvisoryGathering = {
  advisories: Advisory[]
  // false when the source was requested but could not be reached (never throws; reported to the user)
  available: boolean
}

export type AdvisorySource = {
  name: string
  gather(nodes: DependencyNode[]): Promise<AdvisoryGathering>
}

// is a parsed JSON value already one of our native Advisory records (versus an OSV record to convert)?
function isNativeAdvisory(value: unknown): value is Advisory {
  return (
    typeof value === 'object' &&
    value !== null &&
    'packageName' in value &&
    'ranges' in value
  )
}

// parse one advisory file's contents (native Advisory array/object, or an OSV feed) into advisories.
function parseAdvisoryFile(data: unknown, ecosystem: string): Advisory[] {
  const items = Array.isArray(data) ? data : [data]

  // a file of native advisories
  if (items.every(isNativeAdvisory)) {
    return items as Advisory[]
  }

  // otherwise treat it as an OSV feed
  return fromOsvFeed(data as OsvRecord | OsvRecord[], ecosystem)
}

async function readJsonFilesUnder(dir: string): Promise<unknown[]> {
  const out: unknown[] = []

  let entries: string[]

  try {
    entries = await fsp.readdir(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    const full = path.join(dir, entry)
    const stat = await fsp.stat(full)

    if (stat.isDirectory()) {
      out.push(...(await readJsonFilesUnder(full)))
    } else if (entry.endsWith('.json')) {
      try {
        out.push(JSON.parse(await fsp.readFile(full, 'utf-8')))
      } catch {
        // a malformed advisory file is skipped, never fatal to the scan
      }
    }
  }

  return out
}

// a directory of advisory files (native or OSV). Returns every advisory it holds; the matcher filters by version.
export function localDatabaseSource(
  dir: string,
  ecosystem = 'term',
): AdvisorySource {
  return {
    name: `local:${dir}`,
    async gather(): Promise<AdvisoryGathering> {
      const files = await readJsonFilesUnder(dir)
      const advisories: Advisory[] = []

      for (const data of files) {
        advisories.push(...parseAdvisoryFile(data, ecosystem))
      }

      return { advisories, available: true }
    },
  }
}

// a single OSV feed file (a JSON array of OSV records, or one record).
export function osvFileSource(
  file: string,
  ecosystem = 'term',
): AdvisorySource {
  return {
    name: `osv:${file}`,
    async gather(): Promise<AdvisoryGathering> {
      try {
        const data = JSON.parse(await fsp.readFile(file, 'utf-8'))

        return { advisories: fromOsvFeed(data, ecosystem), available: true }
      } catch {
        return { advisories: [], available: false }
      }
    },
  }
}

const REGISTRY_SEVERITIES: Severity[] = [
  'critical',
  'high',
  'moderate',
  'low',
  'info',
]

function toSeverity(text: string): Severity {
  const lower = text.toLowerCase()

  return (
    REGISTRY_SEVERITIES.find(s => s === lower) ??
    (lower === 'medium' ? 'moderate' : 'moderate')
  )
}

// the registry's npm-compatible bulk advisory service, reusing the package manager's client. It reports
// per-installed-version advisories with an npm range string, which we carry as `rangeExpression`.
export function registrySource(root: string): AdvisorySource {
  return {
    name: 'registry',
    async gather(): Promise<AdvisoryGathering> {
      const result = await registryAudit({ root })

      if (!result.available) {
        return { advisories: [], available: false }
      }

      const advisories: Advisory[] = result.advisories.map(a => ({
        id: a.url || `${a.name}@${a.version}`,
        packageName: toRegistryName({ name: a.name }),
        severity: toSeverity(a.severity),
        title: a.title,
        url: a.url,
        ranges: [],
        rangeExpression: a.vulnerableRange,
        references: a.url ? [a.url] : [],
      }))

      return { advisories, available: true }
    },
  }
}

// group advisories by the registry name they affect, so the matcher only tries the advisories for a given package.
export function indexByPackage(
  advisories: Advisory[],
): Map<string, Advisory[]> {
  const map = new Map<string, Advisory[]>()

  for (const advisory of advisories) {
    const list = map.get(advisory.packageName)

    if (list) {
      list.push(advisory)
    } else {
      map.set(advisory.packageName, [advisory])
    }
  }

  return map
}
