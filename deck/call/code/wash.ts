import fsp from 'fs/promises'
import path from 'path'
import { closeRun, count, field, openRun, report, showPath } from '@term/call/code/output'
import { cacheHome } from '@term/call/code/cache-store'
import { HOME_POSIX, projectHome } from '@term/call/code/home'

// EVERY NAME THE FOLDER HAS HAD, kept here on purpose. `.base/term/` became `.base/@cluesurf/term/` on 2026-08-30 and
// `.base/@term/code/` on 2026-10-05 (home.ts). The first rename left the old cache behind whole, and nothing ever
// looked at it again: 13 GB of it in `deck/bind` alone by 2026-09-01. The second MOVES the folder and leaves a link,
// but a move Windows refused leaves the old folder the live one, so a clean names all three
const HOMES = [HOME_POSIX, '.base/@cluesurf/term']

const BUILD_DIRS = ['host', 'make', 'hold', ...HOMES.map(home => `${home}/cache`), '.base/term/cache']

// what `term boot` and `term cast` write: the program boot runs, the browser bundles by content, the bundle and its
// import map, and the Worker. Each is written again by the next boot or cast
const BOOT_DIRS = [...HOMES.flatMap(home => [`${home}/boot`, `${home}/client`]), 'build', 'work']

const TARGETS = ['deck', 'tail', 'boot', 'base']

// the old spelling of a target, still read: `store` was `base` until 2026-10-04, with the folder it names
const RENAMED: Record<string, string> = { store: 'base' }

// remove each that exists under `root`, one `remove` item apiece, and say how many there were
async function removeEach(root: string, dirs: string[], shown: (dir: string) => string): Promise<number> {
  let cleaned = 0

  for (const dir of dirs) {
    const fullPath = path.join(root, dir)

    try {
      await fsp.access(fullPath)
      await fsp.rm(fullPath, { recursive: true, force: true })
      report({ glyph: 'removed', kind: 'change', verb: 'remove', subject: shown(dir) })
      cleaned++
    } catch {
      // directory doesn't exist
    }
  }

  return cleaned
}

// `term wash`: the build's output removed, one `remove` change item per directory that was there (terminal output
// standard, section 9)
export async function callWash(input: {
  root: string
  target?: string
}): Promise<void> {
  const target = input.target === undefined ? undefined : (RENAMED[input.target] ?? input.target)

  openRun({ verb: 'wash', root: input.root, facts: target ? [target] : [] })

  if (input.target !== undefined && RENAMED[input.target]) {
    report({ glyph: 'warning', verb: 'wash', subject: `term wash ${input.target} is term wash ${target} now` })
  }

  // `deck` is the build output, the same as no target, `tail` the logs, `boot` what boot and cast write, `base` the
  // machine-wide module cache. Any other word washed the build output
  if (target !== undefined && !TARGETS.includes(target)) {
    report({ glyph: 'failed', kind: 'problem', subject: `There is nothing named ${target} to wash` })
    closeRun({ verdict: 'Nothing removed', next: 'term wash, or term wash deck, tail, boot or base', failure: 'usage' })

    return
  }

  // the machine-wide cache of parsed modules, which every project shares and the next build of any of them fills
  // again. Not a project's, so it needs no deck.tree. The installed decks beside it (`blobs/`, `index.json`) are not
  // a cache: an offline install reads them, so they stay (guides: commands/wash, 2026-10-04)
  if (target === 'base') {
    const home = cacheHome()
    // the separate build's units are kept here too, beside the parsed modules (compile/separate.ts)
    const cleaned = await removeEach(home, ['mill', 'unit'], dir => `${showPath(path.join(home, dir))}/`)

    closeRun({
      verdict: cleaned > 0 ? 'Shared module cache removed' : 'Nothing to clean',
      counts: [count(cleaned, 'directories', 'directory')],
      done: cleaned > 0,
    })

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
    const logDir = projectHome(input.root, 'log')

    try {
      // a removal is reported only when there was something to remove
      const existed = await fsp.access(logDir).then(
        () => true,
        () => false,
      )
      await fsp.rm(logDir, { recursive: true, force: true })

      if (existed) {
        report({ glyph: 'removed', kind: 'change', verb: 'remove', subject: `${showPath(logDir, input.root)}/` })
      }

      closeRun({ verdict: existed ? 'Logs cleared' : 'No logs to clear', done: existed })
    } catch (err) {
      report({ glyph: 'failed', kind: 'problem', subject: 'The logs could not be removed', message: [err instanceof Error ? err.message : String(err)] })
      closeRun({ verdict: 'Logs not cleared' })
    }

    return
  }

  if (input.target === 'boot') {
    const cleaned = await removeEach(input.root, BOOT_DIRS, dir => `${dir}/`)

    closeRun({
      verdict: cleaned > 0 ? 'Boot output removed' : 'Nothing to clean',
      counts: [count(cleaned, 'directories', 'directory')],
      done: cleaned > 0,
    })

    return
  }

  const cleaned = await removeEach(input.root, BUILD_DIRS, dir => `${dir}/`)

  closeRun({
    verdict: cleaned > 0 ? 'Build output removed' : 'Nothing to clean',
    counts: [count(cleaned, 'directories', 'directory')],
    done: cleaned > 0,
  })
}
