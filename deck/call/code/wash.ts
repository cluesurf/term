import fsp from 'fs/promises'
import path from 'path'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  fade,
} from '@cluesurf/make/code/tint'

const BUILD_DIRS = ['host', 'make', 'hold', '.seed/cache']

export async function callWash(input: {
  root: string
  target?: string
}): Promise<void> {
  if (input.target === 'tail') {
    logStep('Clearing logs...')

    const logDir = path.join(input.root, '.seed', 'log')

    try {
      await fsp.rm(logDir, { recursive: true, force: true })
      logGood('Logs cleared')
    } catch (err) {
      logFail(formatError(err))
    }

    return
  }

  logStep('Cleaning build artifacts...')

  let cleaned = 0

  for (const dir of BUILD_DIRS) {
    const fullPath = path.join(input.root, dir)

    try {
      await fsp.access(fullPath)
      await fsp.rm(fullPath, { recursive: true, force: true })
      console.log(fade(`    removed ${dir}/`))
      cleaned++
    } catch {
      // directory doesn't exist
    }
  }

  if (cleaned > 0) {
    logGood(`Cleaned ${cleaned} directories`)
  } else {
    logGood('Nothing to clean')
  }
}
