// Security audit. Reads the lockfile, asks the registry's advisory service which installed versions have known
// vulnerabilities (the npm-compatible bulk endpoint), and reports them by severity. If the registry has no advisory
// service it degrades gracefully (reported as unavailable, never a crash). This is the `npm audit` equivalent.
import { FetchConfig } from './form'
import { loadLockfile } from './lock'
import { showCode } from './code'
import { makeDefaultFetchConfig } from './fetch'
import { toRegistryName } from './name'

export type Advisory = {
  name: string
  version: string
  severity: string
  title: string
  url: string
  vulnerableRange: string
}

export type AuditResult = {
  advisories: Advisory[]
  bySeverity: Record<string, number>
  packageCount: number
  available: boolean
}

type BulkAdvisory = {
  title?: string
  severity?: string
  url?: string
  vulnerable_versions?: string
}

export async function auditDependencies(input: {
  root: string
  config?: FetchConfig
}): Promise<AuditResult> {
  const config = input.config ?? makeDefaultFetchConfig()
  const lockfile = await loadLockfile({ dir: input.root })

  const empty: AuditResult = {
    advisories: [],
    bySeverity: {},
    packageCount: 0,
    available: true,
  }

  if (!lockfile || lockfile.decks.length === 0) {
    return empty
  }

  // bulk request body: { registryName: [version, ...] }. The lockfile pins one version per package.
  const body: Record<string, string[]> = {}

  for (const entry of lockfile.decks) {
    const registryName = toRegistryName({ name: entry.name })
    const version = showCode(entry.code)
    body[registryName] = [...(body[registryName] ?? []), version]
  }

  const endpoint = `${config.registry}/-/npm/v1/security/advisories/bulk`

  let data: Record<string, BulkAdvisory[]>

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      return { ...empty, available: false }
    }

    data = (await response.json()) as Record<string, BulkAdvisory[]>
  } catch {
    return { ...empty, available: false }
  }

  const advisories: Advisory[] = []
  const bySeverity: Record<string, number> = {}

  for (const [registryName, list] of Object.entries(data)) {
    const version = body[registryName]?.[0] ?? ''

    for (const advisory of list) {
      const severity = advisory.severity ?? 'unknown'
      advisories.push({
        name: registryName,
        version,
        severity,
        title: advisory.title ?? '',
        url: advisory.url ?? '',
        vulnerableRange: advisory.vulnerable_versions ?? '',
      })
      bySeverity[severity] = (bySeverity[severity] ?? 0) + 1
    }
  }

  return {
    advisories,
    bySeverity,
    packageCount: lockfile.decks.length,
    available: true,
  }
}
