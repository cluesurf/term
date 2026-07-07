// Emit findings as SARIF 2.1.0, the format GitHub code scanning ingests (`gh code-scanning upload-sarif`, or the
// upload-sarif action). This is what lets a custom-ecosystem scanner show alerts in the GitHub Security tab even
// though it is not Dependabot: both dependency findings and code findings become SARIF results, so they render
// alongside CodeQL and any other tool.

import path from 'path'
import type {
  Finding,
  ScanResult,
  Severity,
  SourcePoint,
} from './form'

// SARIF `level` per severity. GitHub also reads a numeric `security-severity` property (0-10) for its own ranking.
function sarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') {
    return 'error'
  }

  if (severity === 'moderate') {
    return 'warning'
  }

  return 'note'
}

function securityScore(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return '9.0'
    case 'high':
      return '7.0'
    case 'moderate':
      return '4.0'
    case 'low':
      return '2.0'
    default:
      return '0.0'
  }
}

// a repo-relative, forward-slash URI for a file (SARIF locations are relative to the repo root on GitHub).
function toUri(root: string, file: string): string {
  const rel = path.relative(root, file) || path.basename(file)

  return rel.split(path.sep).join('/')
}

// the SARIF ruleId for a finding: the advisory id for a dependency vulnerability, the rule id for a code finding.
function ruleIdOf(finding: Finding): string {
  return finding.kind === 'dependency'
    ? finding.advisory.id
    : finding.ruleId
}

function physicalLocation(
  root: string,
  point: SourcePoint,
): Record<string, unknown> {
  return {
    physicalLocation: {
      artifactLocation: { uri: toUri(root, point.file) },
      region: { startLine: point.line, startColumn: point.column },
    },
  }
}

export type SarifOptions = {
  root: string
  toolVersion?: string
  // the manifest file dependency findings are anchored to (defaults to `<root>/deck.tree`)
  manifestFile?: string
}

export function toSarif(
  result: ScanResult,
  options: SarifOptions,
): unknown {
  const manifestFile =
    options.manifestFile ?? path.join(options.root, 'deck.tree')

  // one SARIF rule descriptor per distinct ruleId
  const ruleDescriptors = new Map<string, Record<string, unknown>>()

  for (const finding of result.findings) {
    const id = ruleIdOf(finding)

    if (ruleDescriptors.has(id)) {
      continue
    }

    if (finding.kind === 'dependency') {
      ruleDescriptors.set(id, {
        id,
        name: 'VulnerableDependency',
        shortDescription: { text: finding.advisory.title },
        helpUri: finding.advisory.url,
        properties: {
          tags: ['security', 'dependency'],
          'security-severity': securityScore(finding.severity),
        },
      })
    } else {
      ruleDescriptors.set(id, {
        id,
        name: id.replace(/[^A-Za-z0-9]+/g, '_'),
        shortDescription: { text: finding.message },
        properties: {
          tags: ['security'],
          'security-severity': securityScore(finding.severity),
        },
      })
    }
  }

  const results = result.findings.map(finding => {
    if (finding.kind === 'dependency') {
      const message =
        `${finding.node.name}@${finding.node.version} is vulnerable: ` +
        `${finding.advisory.title} (${finding.advisory.id})` +
        (finding.fixVersion
          ? `. Upgrade to ${finding.fixVersion}.`
          : '.')

      return {
        ruleId: finding.advisory.id,
        level: sarifLevel(finding.severity),
        message: { text: message },
        locations: [
          physicalLocation(options.root, {
            file: manifestFile,
            line: 1,
            column: 1,
          }),
        ],
        partialFingerprints: {
          package: `${finding.node.registryName}@${finding.node.version}`,
          advisory: finding.advisory.id,
        },
      }
    }

    const base: Record<string, unknown> = {
      ruleId: finding.ruleId,
      level: sarifLevel(finding.severity),
      message: { text: finding.message },
      locations: [physicalLocation(options.root, finding.at)],
    }

    // render a taint trace as a SARIF code flow (GitHub shows the source-to-sink path)
    if (finding.trace && finding.trace.length > 0) {
      base.codeFlows = [
        {
          threadFlows: [
            {
              locations: finding.trace.map(step => ({
                location: {
                  ...physicalLocation(options.root, step),
                  message: { text: step.label },
                },
              })),
            },
          ],
        },
      ]
    }

    return base
  })

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'term-scan',
            informationUri: 'https://term.surf',
            version: options.toolVersion ?? '0.1.0',
            rules: [...ruleDescriptors.values()],
          },
        },
        results,
      },
    ],
  }
}

export function toSarifJson(
  result: ScanResult,
  options: SarifOptions,
): string {
  return JSON.stringify(toSarif(result, options), null, 2)
}
