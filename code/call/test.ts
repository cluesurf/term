import { logGood, logFail, logStep, formatError } from '../tint'
import { runCommand } from './make'

export async function callTest(input: {
  root: string
  filter?: string
}): Promise<void> {
  logStep('Running tests...')

  try {
    // delegate to vitest or the project's test script
    const fs = await import('fs/promises')
    const path = await import('path')
    const pkgJsonPath = path.join(input.root, 'package.json')
    let hasTestScript = false

    try {
      const pkgText = await fs.readFile(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(pkgText)
      hasTestScript = Boolean(pkg.scripts?.test)
    } catch {
      // no package.json
    }

    if (hasTestScript) {
      const args = ['run', 'test']
      if (input.filter) {
        args.push('--', input.filter)
      }
      await runCommand({ cmd: 'pnpm', args, cwd: input.root })
      logGood('Tests complete')
    } else {
      logFail('No test script found in package.json')
      process.exit(1)
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
