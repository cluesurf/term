import { verifyInstall, auditDependencies } from '@cluesurf/deck.tree'
import {
  logGood,
  logFail,
  logWarn,
  formatError,
  name,
  fade,
} from '@cluesurf/make/code/tint'

export async function callSeek(input: {
  root: string
  audit?: boolean
}): Promise<void> {
  if (input.audit) {
    await runAudit(input.root)

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

// `seed seek --audit`: report known security advisories for the installed dependency versions.
async function runAudit(root: string): Promise<void> {
  try {
    const result = await auditDependencies({ root })

    if (!result.available) {
      logWarn(
        'The registry has no advisory service; could not check for vulnerabilities.',
      )

      return
    }

    if (result.advisories.length === 0) {
      logGood(
        `No known vulnerabilities in ${result.packageCount} package(s)`,
      )

      return
    }

    const order = ['critical', 'high', 'moderate', 'low', 'info']
    const summary = order
      .filter(severity => result.bySeverity[severity])
      .map(severity => `${result.bySeverity[severity]} ${severity}`)
      .join(', ')

    logWarn(
      `${result.advisories.length} known vulnerabilit(ies): ${summary}`,
    )

    for (const advisory of result.advisories) {
      console.log('')
      console.log(
        `    ${name(advisory.name)}@${advisory.version}  [${advisory.severity}]`,
      )
      console.log(`    ${advisory.title}`)

      if (advisory.vulnerableRange) {
        console.log(fade(`    vulnerable: ${advisory.vulnerableRange}`))
      }

      if (advisory.url) {
        console.log(fade(`    ${advisory.url}`))
      }
    }

    console.log('')
    process.exit(1)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
