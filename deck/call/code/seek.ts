// `term seek`: is every package installed, and with `--audit` the security scan. Prints through the terminal output
// library (code/output.ts): a `seek` run, one item per missing or outdated package, one Problem item per security
// finding, and a closing verdict. `--format json` and `--format sarif` are DATA on stdout, as they were.

import { verifyInstall } from '@cluesurf/deck.tree'
import fsp from 'fs/promises'
import { runScan, failsThreshold } from '@term/scan/code/scan'
import { toJson } from '@term/scan/code/report'
import { toSarifJson } from '@term/scan/code/sarif'
import { planUpgrades, applyUpgrades } from '@term/scan/code/fix'
import { closeRun, count, failRun, field, location, openRun, printData, report } from '@term/call/code/output'

type ScanResult = Awaited<ReturnType<typeof runScan>>
type Finding = ScanResult['findings'][number]

export async function callSeek(input: {
  root: string
  audit?: boolean
  // `--code`: also run the static code scan (not just the dependency audit)
  code?: boolean
  // `--sarif <path>`: write a SARIF 2.1.0 report for GitHub code scanning
  sarif?: string
  // `--format`: human (default), json, or sarif (to stdout)
  format?: 'human' | 'json' | 'sarif'
  // `--fix`: rewrite the manifest to the safe dependency versions
  fix?: boolean
}): Promise<void> {
  if (input.audit) {
    await runAudit(input)

    return
  }

  openRun({ verb: 'seek', root: input.root })

  try {
    const result = await verifyInstall({ root: input.root })

    if (result.ok) {
      closeRun({ verdict: 'Every package is installed' })

      return
    }

    for (const pkg of result.missing) {
      report({ glyph: 'failed', kind: 'problem', verb: 'missing', subject: pkg })
    }

    for (const pkg of result.outdated) {
      report({ glyph: 'failed', kind: 'problem', verb: 'outdated', subject: pkg })
    }

    closeRun({
      verdict: 'Packages are not installed as declared',
      counts: [
        ...(result.missing.length ? [count(result.missing.length, 'missing')] : []),
        ...(result.outdated.length ? [count(result.outdated.length, 'outdated')] : []),
      ],
      next: 'term load',
    })
  } catch (err) {
    failRun(err, input.root)
  }
}

// `term seek --audit`: the security scan. Audits installed dependency versions against the advisory database (the
// Dependabot equivalent) and, with `--code`, runs the static rules over the project's own `.tree` sources. Reports
// as items, JSON, or SARIF (for GitHub code scanning), and with `--fix` rewrites the manifest to safe versions.
async function runAudit(input: {
  root: string
  code?: boolean
  sarif?: string
  format?: 'human' | 'json' | 'sarif'
  fix?: boolean
}): Promise<void> {
  const format = input.format ?? 'human'

  openRun({ verb: 'seek', root: input.root, facts: ['--audit', ...(input.code ? ['--code'] : [])] })

  try {
    const result = await runScan({
      root: input.root,
      deps: true,
      code: input.code ?? false,
    })

    // write a SARIF file for GitHub code scanning when asked, regardless of the console format
    if (input.sarif) {
      await fsp.writeFile(
        input.sarif,
        toSarifJson(result, { root: input.root }),
        'utf-8',
      )
      report({ glyph: 'done', verb: 'write', subject: input.sarif, facts: ['SARIF 2.1.0'] })
    }

    // the report the user asked for, on stdout, unchanged: the human view stays on stderr
    if (format === 'json') {
      printData(`${toJson(result)}\n`)
    } else if (format === 'sarif') {
      printData(`${toSarifJson(result, { root: input.root })}\n`)
    } else {
      reportFindings(result)
    }

    // apply fixes to the manifest when asked (the PR is opened separately by the repo's PR tool)
    if (input.fix) {
      await applyFixes(input.root, result)
    }

    // the exit follows the threshold through the glyphs: a finding over it is ✗ (exit 1), one under it ▲ (exit 0)
    closeRun({
      verdict: result.findings.length === 0 ? 'No security findings' : `${result.findings.length} security finding${result.findings.length === 1 ? '' : 's'}`,
      counts: [
        count(result.dependencyCount, 'dependencies', 'dependency'),
        ...(result.fileCount ? [count(result.fileCount, 'files', 'file')] : []),
      ],
    })
  } catch (err) {
    failRun(err, input.root)
  }
}

// each finding a Problem item: a vulnerable dependency under `audit`, a code finding under `check` with its place
function reportFindings(result: ScanResult): void {
  for (const source of result.unavailableSources) {
    report({ glyph: 'warning', verb: 'fetch', subject: 'An advisory source was unavailable and was skipped', fields: [field('source', source)] })
  }

  for (const finding of result.findings) {
    const fails = failsThreshold({ ...result, findings: [finding] }, 'low')
    const glyph = fails ? 'failed' : 'warning'

    if (finding.kind === 'dependency') {
      const fields = [field('package', `${finding.node.name} ${finding.node.version}`)]

      if (finding.node.path.length > 1) {
        fields.push(field('via', finding.node.path.join(' › ')))
      }

      fields.push(field('link', finding.advisory.url))
      fields.push(finding.fixVersion ? field('fix', `upgrade to ${finding.fixVersion}`) : field('why', 'no known safe upgrade'))
      report({ glyph, kind: 'problem', verb: 'audit', subject: finding.advisory.title, facts: [finding.severity, finding.advisory.id], fields })
      continue
    }

    report({
      glyph,
      kind: 'problem',
      verb: 'check',
      subject: capital(finding.message),
      facts: [finding.severity, finding.ruleId],
      fields: [
        location(`${finding.at.file}:${finding.at.line}:${finding.at.column}`),
        ...(finding.trace ?? []).map(step => ({ ...field(step.label, `${step.file}:${step.line}:${step.column}`), location: true })),
      ],
      place: { path: finding.at.file, line: finding.at.line, column: finding.at.column },
    })
  }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

async function applyFixes(root: string, result: ScanResult): Promise<void> {
  const depFindings = result.findings.filter(
    (f): f is Extract<Finding, { kind: 'dependency' }> =>
      f.kind === 'dependency',
  )
  const upgrades = planUpgrades(depFindings)

  if (upgrades.length === 0) {
    report({ glyph: 'info', verb: 'fix', subject: 'No dependency upgrade to apply' })

    return
  }

  const { applied } = await applyUpgrades({ root, upgrades, write: true })

  if (applied.length === 0) {
    report({ glyph: 'warning', verb: 'fix', subject: 'Upgrades were computed but no manifest line matched, so nothing was written' })

    return
  }

  for (const upgrade of applied) {
    report({ glyph: 'changed', kind: 'change', verb: 'update', subject: upgrade.name, facts: [`${upgrade.from} → ${upgrade.to}`] })
  }

  report({
    glyph: 'done',
    verb: 'write',
    subject: 'deck.tree',
    counts: [count(applied.length, 'upgrades', 'upgrade')],
    fields: [field('next', 'term load, then open a PR with the updated deck.tree and lock.tree')],
  })
}
