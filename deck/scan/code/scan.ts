// The top-level scan: run the dependency audit and the code scan together and merge them into one `ScanResult`.
// This is the entry point the CLI and CI call. Either half can be turned off; by default both run.

import type { Finding, ScanResult, Severity } from './form'
import { SEVERITY_ORDER, severityRank } from './form'
import type { AdvisorySource } from './advisory'
import type { Rule } from './rule'
import { auditDependencies } from './audit'
import { scanProject } from './code-scan'

export async function runScan(input: {
  root: string
  // audit dependencies against the advisory database (default true)
  deps?: boolean
  // run static rules over the project's `.tree` code (default true)
  code?: boolean
  sources?: AdvisorySource[]
  rules?: Rule[]
  // only report vulnerabilities in direct dependencies
  directOnly?: boolean
}): Promise<ScanResult> {
  const doDeps = input.deps ?? true
  const doCode = input.code ?? true

  const findings: Finding[] = []
  const advisorySources: string[] = []
  const unavailableSources: string[] = []
  let dependencyCount = 0
  let fileCount = 0

  if (doDeps) {
    const audit = await auditDependencies({
      root: input.root,
      sources: input.sources,
      directOnly: input.directOnly,
    })
    findings.push(...audit.findings)
    dependencyCount = audit.dependencyCount
    advisorySources.push(...audit.consultedSources)
    unavailableSources.push(...audit.unavailableSources)
  }

  if (doCode) {
    const scan = await scanProject({
      root: input.root,
      rules: input.rules,
    })
    findings.push(...scan.findings)
    fileCount = scan.fileCount
  }

  // sort worst-first so the most severe findings lead
  findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity))

  const bySeverity = Object.fromEntries(
    SEVERITY_ORDER.map(s => [s, 0]),
  ) as Record<Severity, number>

  for (const finding of findings) {
    bySeverity[finding.severity]++
  }

  return {
    findings,
    dependencyCount,
    fileCount,
    bySeverity,
    advisorySources,
    unavailableSources,
  }
}

// a single boolean gate for CI: does the result contain any finding at or above a threshold severity?
export function failsThreshold(
  result: ScanResult,
  threshold: Severity = 'high',
): boolean {
  const bar = severityRank(threshold)

  return result.findings.some(f => severityRank(f.severity) >= bar)
}
