// The dependency audit engine: the Dependabot equivalent. Read the resolved dependency graph, gather advisories
// from every configured source, match each installed version against the advisories for its package, and emit a
// finding per (vulnerable package, advisory) pair with the lowest safe upgrade attached. Sources that are
// unreachable are recorded, never fatal.

import type {
  Advisory,
  DependencyFinding,
  DependencyNode,
} from './form'
import type { AdvisorySource } from './advisory'
import {
  indexByPackage,
  localDatabaseSource,
  registrySource,
} from './advisory'
import { readDependencyGraph } from './graph'
import { isAffected, planUpgrade } from './match'

export type DependencyAudit = {
  findings: DependencyFinding[]
  dependencyCount: number
  consultedSources: string[]
  unavailableSources: string[]
}

// the default advisory sources for a project: its local advisory database (if present) plus the registry service.
export function defaultSources(root: string): AdvisorySource[] {
  return [
    localDatabaseSource(`${root}/advisory`),
    registrySource(root),
  ]
}

export async function auditDependencies(input: {
  root: string
  sources?: AdvisorySource[]
  // when true, only direct dependencies are reported (transitive vulnerabilities are still found but filtered out)
  directOnly?: boolean
}): Promise<DependencyAudit> {
  const nodes = await readDependencyGraph(input.root)
  const sources = input.sources ?? defaultSources(input.root)

  const allAdvisories: Advisory[] = []
  const consultedSources: string[] = []
  const unavailableSources: string[] = []

  for (const source of sources) {
    const gathering = await source.gather(nodes)

    if (gathering.available) {
      consultedSources.push(source.name)
      allAdvisories.push(...gathering.advisories)
    } else {
      unavailableSources.push(source.name)
    }
  }

  const byPackage = indexByPackage(allAdvisories)
  const findings: DependencyFinding[] = []

  for (const node of nodes) {
    if (input.directOnly && !node.direct) {
      continue
    }

    const advisories = byPackage.get(node.registryName) ?? []
    const hits: Advisory[] = advisories.filter(a =>
      isAffected(node.version, a),
    )

    if (hits.length === 0) {
      continue
    }

    // one fix that clears all advisories for this package, computed once and shared across its findings
    const fixVersion = planUpgrade(node.version, hits)

    for (const advisory of hits) {
      findings.push({
        kind: 'dependency',
        advisory,
        node,
        severity: advisory.severity,
        fixVersion,
      })
    }
  }

  return {
    findings,
    dependencyCount: nodes.length,
    consultedSources,
    unavailableSources,
  }
}

// the set of upgrades an audit implies: one target version per vulnerable package (deduplicated across advisories).
export function upgradesFrom(
  findings: DependencyFinding[],
): { name: string; from: string; to: string }[] {
  const byName = new Map<string, { from: string; to: string }>()

  for (const finding of findings) {
    if (!finding.fixVersion) {
      continue
    }

    byName.set(finding.node.name, {
      from: finding.node.version,
      to: finding.fixVersion,
    })
  }

  return [...byName].map(([name, versions]) => ({ name, ...versions }))
}

export type { DependencyNode }
