import fsp from 'fs/promises'
import path from 'path'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  fade,
} from '@term/make/code/tint'

// `.base/term/cache` is the PRE-RENAME path, kept here on purpose. `.base/term/` became
// `.base/@cluesurf/term/` on 2026-08-30, and a cache deliberately does not travel through `keptAt` on a rename
// because the next build regenerates it. Nothing said what happens to the old copy, so it was left behind whole and
// nothing ever looked at it again: 13 GB of it in `deck/bind` alone by 2026-09-01. A clean means both.
const BUILD_DIRS = [
  'host',
  'make',
  'hold',
  '.base/@cluesurf/term/cache',
  '.base/term/cache',
]

export async function callWash(input: {
  root: string
  target?: string
}): Promise<void> {
  if (input.target === 'tail') {
    logStep('Clearing logs...')

    const logDir = path.join(input.root, '.base/@cluesurf/term', 'log')

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
