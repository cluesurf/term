// Render a scan result for humans (a terminal summary) and for machines (a stable JSON shape). SARIF lives in its
// own module; these two are for direct reading and for piping into other tools.

import type { ScanResult, Finding, Severity } from './form'
import { SEVERITY_ORDER } from './form'

// a compact one-line-per-finding severity summary, e.g. "2 critical, 1 high".
export function severitySummary(result: ScanResult): string {
  return SEVERITY_ORDER.filter(s => result.bySeverity[s] > 0)
    .map(s => `${result.bySeverity[s]} ${s}`)
    .join(', ')
}

function describeFinding(finding: Finding): string {
  if (finding.kind === 'dependency') {
    const via =
      finding.node.path.length > 1
        ? ` (via ${finding.node.path.join(' -> ')})`
        : ''
    const fix = finding.fixVersion
      ? `  fix: upgrade to ${finding.fixVersion}`
      : '  fix: no known safe upgrade'

    return [
      `  [${finding.severity}] ${finding.node.name}@${finding.node.version}${via}`,
      `    ${finding.advisory.title} (${finding.advisory.id})`,
      `    ${finding.advisory.url}`,
      `  ${fix}`,
    ].join('\n')
  }

  const trace =
    finding.trace && finding.trace.length > 0
      ? finding.trace
          .map(t => `      ${t.label}: ${t.file}:${t.line}:${t.column}`)
          .join('\n')
      : undefined

  return [
    `  [${finding.severity}] ${finding.ruleId}  ${finding.at.file}:${finding.at.line}:${finding.at.column}`,
    `    ${finding.message}`,
    ...(trace ? [trace] : []),
  ].join('\n')
}

// a full human-readable report.
export function formatHuman(result: ScanResult): string {
  const lines: string[] = []

  const depFindings = result.findings.filter(
    f => f.kind === 'dependency',
  )
  const codeFindings = result.findings.filter(f => f.kind === 'code')

  lines.push(
    `Scanned ${result.dependencyCount} dependenc(ies) and ${result.fileCount} file(s).`,
  )

  if (result.advisorySources.length > 0) {
    lines.push(`Advisory sources: ${result.advisorySources.join(', ')}.`)
  }

  if (result.unavailableSources.length > 0) {
    lines.push(
      `Unavailable sources (skipped): ${result.unavailableSources.join(', ')}.`,
    )
  }

  if (result.findings.length === 0) {
    lines.push('No security findings.')

    return lines.join('\n')
  }

  lines.push('')
  lines.push(`${result.findings.length} finding(s): ${severitySummary(result)}`)

  if (depFindings.length > 0) {
    lines.push('')
    lines.push('Vulnerable dependencies:')

    for (const finding of depFindings) {
      lines.push(describeFinding(finding))
    }
  }

  if (codeFindings.length > 0) {
    lines.push('')
    lines.push('Code findings:')

    for (const finding of codeFindings) {
      lines.push(describeFinding(finding))
    }
  }

  return lines.join('\n')
}

// a stable machine-readable JSON report.
export function toJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2)
}

export type { Severity }
