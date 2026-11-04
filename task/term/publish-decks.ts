// Publish every deck of the Term workspace, each on its own, in the order its links need.
//
// THE WORKSPACE IS A DEVELOPMENT FACT, NOT A PUBLISHING ONE. Each deck under deck/, and zone beside
// it, is a package with its own name, version and `link` lines, published to its own repository by `term host` from
// its own folder, exactly as if it lived alone (note/project/term/registry/19-package-index.md). This only does it for all of
// them, in an order where a deck goes after every deck it links, so a deck is never on the registry before what it
// needs to install.
//
//   pnpm term:publish-decks                       the plan: each deck, its version, its links, and whether the registry
//                                                 already holds that version. Pushes nothing
//   pnpm term:publish-decks --commit              publish every deck the registry does not hold yet, stopping at the
//                                                 first failure so nothing after it goes out on a missing dependency
//   pnpm term:publish-decks --only base,bind      the same, for these decks
//
// A VERSION IS WRITE-ONCE. A deck whose version is already on the registry is skipped, and `term host` itself refuses
// the same version with other bytes, so a deck whose code changed since its last publish needs its `mark` raised (to
// the next even patch) before it goes out again. `pnpm term:deck-links` first: a deck that uses another without
// linking it installs broken.
//
// Run from the repository root. Credentials come from zone (`cluesurf`), as `pnpm term:release` takes them, and only
// `--commit` asks for them.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { httpTransport } from '@term/deck/code/oci/transport'
import { loadManifest } from '@term/deck/code/package/manifest'
import { topologicalSort } from '@term/deck/code/package/workspace'
import { showCode } from '@term/deck/code/code'
import type { DeckManifest } from '@term/deck/code/form'
import { TERM_ROOT, parentPaths, zoneCommand } from './root'

// the Term package root: the alias runs this from there, as it runs cli-drift
const TERM = TERM_ROOT
const HOME = TERM_ROOT
const ZONE = (): string => zoneCommand()
const LINE = join(TERM, 'host', 'line.js')

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const onlyAt = argv.indexOf('--only')
const only = onlyAt >= 0 ? new Set((argv[onlyAt + 1] ?? '').split(',').map(name => `@term/${name.trim()}`)) : undefined

type Deck = { name: string; dir: string; manifest: DeckManifest }

const dirs = [
  ...readdirSync(join(TERM, 'deck'))
    .map(name => join(TERM, 'deck', name))
    .filter(dir => existsSync(join(dir, 'deck.tree'))),
  ...parentPaths('deck/zone'),
]
// what the registry holds, read anonymously: `@term/x` lives at ghcr.io/cluesurf/term/x
const registry = httpTransport({ host: 'ghcr.io', retries: 0 })

async function published(name: string): Promise<string[]> {
  try {
    return await registry.listTags({ repository: `cluesurf/term/${name.split('/')[1]}` })
  } catch {
    // a repository that does not exist yet, or one still private, holds nothing a reader can see
    return []
  }
}

async function main(): Promise<void> {
  const decks = new Map<string, Deck>()

  for (const dir of dirs) {
    const manifest = await loadManifest({ dir })
    const name = manifest.host ? `@${manifest.host}/${manifest.name}` : manifest.name

    decks.set(name, { name, dir, manifest })
  }

  const order = topologicalSort({ workspaces: new Map([...decks].map(([name, deck]) => [name, deck.manifest])) }).filter(
    name => !only || only.has(name),
  )

  let failed: string | undefined
  let sent = 0

  console.log(`term publish-decks: ${order.length} decks, in the order their links need${commit ? '' : ', a plan: nothing is pushed'}\n`)

  for (const name of order) {
    const deck = decks.get(name)!
    const version = showCode(deck.manifest.mark)
    const links = deck.manifest.link.map(link => link.name).join(', ') || 'none'
    const held = (await published(name)).includes(version)

    console.log(`${held ? 'held ' : 'new  '} ${name}@${version}  ${relative(HOME, deck.dir)}  links ${links}`)

    if (!commit || held) {
      continue
    }

    // `term host` from the deck's own folder, under zone for the registry credential, printing its own run
    const code = await new Promise<number | null>(resolve =>
      spawn(ZONE(), ['load', 'cluesurf', '--', process.execPath, LINE, 'host'], { cwd: deck.dir, stdio: 'inherit' }).on('close', resolve),
    )

    if (code !== 0) {
      failed = `${name}@${version}`
      break
    }

    sent++
  }

  console.log(
    failed
      ? `\nterm publish-decks: ${failed} did not publish, so nothing after it was tried. ${sent} published`
      : commit
        ? `\nterm publish-decks: ${sent} published`
        : `\nterm publish-decks: run with --commit to publish the decks marked new`,
  )

  if (failed) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
