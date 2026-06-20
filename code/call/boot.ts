import { logFail, logStep, formatError } from '../tint'
import { runCommand } from './make'

export async function callBoot(input: { root: string }): Promise<void> {
  logStep('Starting app...')

  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    const pkgJsonPath = path.join(input.root, 'package.json')
    let hasStartScript = false

    try {
      const pkgText = await fs.readFile(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(pkgText)
      hasStartScript = Boolean(pkg.scripts?.start || pkg.scripts?.boot)
    } catch {
      // no package.json
    }

    if (hasStartScript) {
      await runCommand({
        cmd: 'pnpm',
        args: ['start'],
        cwd: input.root,
      })
    } else {
      logFail('No start/boot script found in package.json')
      process.exit(1)
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
