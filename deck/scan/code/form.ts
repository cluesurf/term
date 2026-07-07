// The data model for @cluesurf/scan: the security scanner for the Term package ecosystem. It has two independent
// layers, matching what GitHub splits across Dependabot and code scanning:
//   1. dependency audit: match installed dependency versions against a vulnerability advisory database (the
//      Dependabot equivalent). Sources: a local advisory database, imported OSV records, and the registry's
//      npm-compatible bulk advisory service.
//   2. code scan: run static rules over the milled Term AST to flag dangerous patterns in first-party code
//      (the code-scanning / Semgrep equivalent), including a small param-to-sink taint check.
// Both layers produce `Finding`s, which the reporters render as text, JSON, or SARIF (for GitHub code scanning).

// severity ordered high to low, matching npm / GitHub advisory vocabulary
export type Severity =
  | 'critical'
  | 'high'
  | 'moderate'
  | 'low'
  | 'info'

// one vulnerable version window for an advisory. Semantics match OSV: a version is affected when
// `introduced <= v` and (`fixed` absent or `v < fixed`) and (`lastAffected` absent or `v <= lastAffected`).
export type AdvisoryRange = {
  // the first affected version. Absent or '0' means "from the beginning".
  introduced?: string
  // the first FIXED version (exclusive upper bound). Absent means unbounded above.
  fixed?: string
  // the inclusive last affected version (OSV `last_affected`), an alternative to `fixed`.
  lastAffected?: string
}

// a single known vulnerability affecting one package.
export type Advisory = {
  // the primary id (GHSA-…, CVE-…, or an OSV id)
  id: string
  // the affected package, as its registry name (with the `.tree` suffix, matching lockfile entries)
  packageName: string
  severity: Severity
  title: string
  url: string
  // vulnerable-version specification. All three forms are OR-combined; a version matching ANY is affected:
  //   - `ranges`: structured windows (from OSV SEMVER/ECOSYSTEM events)
  //   - `versions`: an explicit affected-version list (OSV `versions`)
  //   - `rangeExpression`: an npm-style comparator range string (from the registry bulk service)
  ranges: AdvisoryRange[]
  versions?: string[]
  rangeExpression?: string
  // known fixed versions, used by the fixer to pick a safe upgrade
  fixedVersions?: string[]
  aliases?: string[]
  references?: string[]
}

// one node in the resolved dependency graph.
export type DependencyNode = {
  // the tree name (no `.tree` suffix), as written in code
  name: string
  // the registry name (with `.tree`), as stored in the lockfile and matched against advisories
  registryName: string
  // the exact resolved version
  version: string
  // a direct dependency of the root package (versus transitive)
  direct: boolean
  // the shortest dependency path from the root to this node, by name, for reporting
  path: string[]
}

// a dependency vulnerability: an installed version matched an advisory.
export type DependencyFinding = {
  kind: 'dependency'
  advisory: Advisory
  node: DependencyNode
  severity: Severity
  // the lowest safe upgrade, when one can be computed from the advisory's fixed versions
  fixVersion?: string
}

// a point in source, for code findings and taint traces.
export type SourcePoint = {
  file: string
  line: number
  column: number
}

// a dangerous pattern found in first-party code by a static rule.
export type CodeFinding = {
  kind: 'code'
  ruleId: string
  severity: Severity
  message: string
  at: SourcePoint
  // optional data-flow trace, source first, sink last (for taint findings)
  trace?: (SourcePoint & { label: string })[]
}

export type Finding = DependencyFinding | CodeFinding

// the outcome of a scan.
export type ScanResult = {
  findings: Finding[]
  dependencyCount: number
  fileCount: number
  bySeverity: Record<Severity, number>
  // which advisory sources were consulted (for honest "we checked X, Y" reporting)
  advisorySources: string[]
  // an advisory source was requested but unreachable (e.g. offline registry); reported, never a crash
  unavailableSources: string[]
}

export const SEVERITY_ORDER: Severity[] = [
  'critical',
  'high',
  'moderate',
  'low',
  'info',
]

// rank a severity for sorting / comparison (higher = worse)
export function severityRank(severity: Severity): number {
  const index = SEVERITY_ORDER.indexOf(severity)

  return index === -1 ? 0 : SEVERITY_ORDER.length - index
}
