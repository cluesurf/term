import { verifyInstall } from '@cluesurf/deck.tree'
import fsp from 'fs/promises'
import {
  logGood,
  logFail,
  logWarn,
  formatError,
  name,
  fade,
} from '@term/make/code/tint'
import { runScan, failsThreshold } from '@term/scan/code/scan'
import { formatHuman, toJson } from '@term/scan/code/report'
import { toSarifJson } from '@term/scan/code/sarif'
import { planUpgrades, applyUpgrades } from '@term/scan/code/fix'

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

  try {
    const result = await verifyInstall({ root: input.root })

    if (result.ok) {
      logGood('All packages are installed correctly')

      return
    }

    if (result.missing.length > 0) {
      logWarn('Missing packages:')

      for (const pkg of result.missing) {
        console.log(`    ${name(pkg)}`)
      }
    }

    if (result.outdated.length > 0) {
      logWarn('Outdated packages:')

      for (const pkg of result.outdated) {
        console.log(`    ${name(pkg)}`)
      }
    }

    console.log('')
    console.log(fade('  Run `seed load` to fix.'))
    process.exit(1)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}

// `term seek --audit`: the security scan. Audits installed dependency versions against the advisory database (the
// Dependabot equivalent) and, with `--code`, runs the static rules over the project's own `.tree` sources. Reports
// as text, JSON, or SARIF (for GitHub code scanning), and with `--fix` rewrites the manifest to safe versions.
async function runAudit(input: {
  root: string
  code?: boolean
  sarif?: string
  format?: 'human' | 'json' | 'sarif'
  fix?: boolean
}): Promise<void> {
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
      // to stderr so `--format json` / `--format sarif` keep stdout a clean, pipeable payload
      console.error(fade(`  Wrote SARIF report to ${input.sarif}`))
    }

    const format = input.format ?? 'human'

    if (format === 'json') {
      console.log(toJson(result))
    } else if (format === 'sarif') {
      console.log(toSarifJson(result, { root: input.root }))
    } else {
      renderHuman(result)
    }

    // apply fixes to the manifest when asked (the PR is opened separately by the repo's PR tool)
    if (input.fix) {
      await applyFixes(input.root, result)
    }

    if (failsThreshold(result, 'low')) {
      process.exit(1)
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}

function renderHuman(
  result: Awaited<ReturnType<typeof runScan>>,
): void {
  for (const source of result.unavailableSources) {
    logWarn(`Advisory source unavailable, skipped: ${source}`)
  }

  if (result.findings.length === 0) {
    logGood(
      `No security findings in ${result.dependencyCount} dependenc(ies)` +
        (result.fileCount ? ` and ${result.fileCount} file(s)` : ''),
    )

    return
  }

  logWarn(
    `${result.findings.length} security finding(s) across ${result.dependencyCount} dependenc(ies)` +
      (result.fileCount ? ` and ${result.fileCount} file(s)` : ''),
  )
  console.log('')
  console.log(formatHuman(result))
  console.log('')
}

async function applyFixes(
  root: string,
  result: Awaited<ReturnType<typeof runScan>>,
): Promise<void> {
  const depFindings = result.findings.filter(
    (f): f is Extract<typeof f, { kind: 'dependency' }> =>
      f.kind === 'dependency',
  )
  const upgrades = planUpgrades(depFindings)

  if (upgrades.length === 0) {
    console.log(fade('  No dependency upgrades to apply.'))

    return
  }

  const { applied } = await applyUpgrades({ root, upgrades, write: true })

  if (applied.length === 0) {
    logWarn(
      'Computed upgrades but no manifest lines matched; nothing written.',
    )

    return
  }

  logGood(`Updated ${applied.length} dependenc(ies) in deck.tree:`)

  for (const upgrade of applied) {
    console.log(
      `    ${name(upgrade.name)}  ${upgrade.from} -> ${upgrade.to}`,
    )
  }

  console.log('')
  console.log(
    fade(
      '  Run `term load` to install, then open a PR with the updated deck.tree / lock.tree.',
    ),
  )
}
