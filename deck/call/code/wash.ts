import fsp from 'fs/promises'
import path from 'path'
import { closeRun, count, field, openRun, report, showPath } from '@term/call/code/output'

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

// `term wash`: the build's output removed, one `remove` change item per directory that was there (terminal output
// standard, section 9)
export async function callWash(input: {
  root: string
  target?: string
}): Promise<void> {
  openRun({ verb: 'wash', root: input.root, facts: input.target ? [input.target] : [] })

  // `deck` is the build output, the same as no target, and `tail` the logs. Any other word washed the build output
  if (input.target !== undefined && input.target !== 'deck' && input.target !== 'tail') {
    report({ glyph: 'failed', kind: 'problem', subject: `There is nothing named ${input.target} to wash` })
    closeRun({ verdict: 'Nothing removed', next: 'term wash, term wash deck or term wash tail', failure: 'usage' })

    return
  }

  // only in a project: `make/`, `host/` and `hold/` are ordinary folder names, and outside a deck they are somebody's
  // own. It deleted them from any folder (guides: commands/wash, 2026-10-04)
  const isProject = await fsp.access(path.join(input.root, 'deck.tree')).then(
    () => true,
    () => false,
  )

  if (!isProject) {
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no deck.tree here, so nothing here is a build to wash', fields: [field('looked', showPath(input.root))] })
    closeRun({ verdict: 'Nothing removed', next: 'term wash, in the folder that holds the deck.tree' })

    return
  }

  if (input.target === 'tail') {
    const logDir = path.join(input.root, '.base/@cluesurf/term', 'log')

    try {
      // a removal is reported only when there was something to remove
      const existed = await fsp.access(logDir).then(
        () => true,
        () => false,
      )
      await fsp.rm(logDir, { recursive: true, force: true })

      if (existed) {
        report({ glyph: 'removed', kind: 'change', verb: 'remove', subject: '.base/@cluesurf/term/log/' })
      }

      closeRun({ verdict: existed ? 'Logs cleared' : 'No logs to clear', done: existed })
    } catch (err) {
      report({ glyph: 'failed', kind: 'problem', subject: 'The logs could not be removed', message: [err instanceof Error ? err.message : String(err)] })
      closeRun({ verdict: 'Logs not cleared' })
    }

    return
  }

  let cleaned = 0

  for (const dir of BUILD_DIRS) {
    const fullPath = path.join(input.root, dir)

    try {
      await fsp.access(fullPath)
      await fsp.rm(fullPath, { recursive: true, force: true })
      report({ glyph: 'removed', kind: 'change', verb: 'remove', subject: `${dir}/` })
      cleaned++
    } catch {
      // directory doesn't exist
    }
  }

  closeRun({
    verdict: cleaned > 0 ? 'Build output removed' : 'Nothing to clean',
    counts: [count(cleaned, 'directories', 'directory')],
    done: cleaned > 0,
  })
}
