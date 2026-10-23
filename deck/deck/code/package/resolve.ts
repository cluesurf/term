// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/resolve.ts had, with
// their shapes, answered by deck/deck/code/package/resolution.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import type { DeckManifest, FetchConfig, Lockfile, ResolutionMap, ResolvedDeck } from '@term/deck/code/form'
import * as port from '@term/deck/code/package/resolution'
import { refused } from './grammars'
import { code, portManifest } from './manifest'

type AnyCode = { major: number; minor: number; patch: number; prerelease?: string; build?: string }
const portCode = (value: AnyCode) => ({ major: value.major, minor: value.minor, patch: value.patch, prerelease: value.prerelease ?? '', build: value.build ?? '' })

const portLock = (lock: Lockfile) => ({ ...lock, decks: lock.decks.map(d => ({ ...d, code: portCode(d.code) })), ...(lock.need ? { need: { ...lock.need, code: portCode(lock.need.code) } } : {}) })

function fromPort(resolution: { decks: Map<string, ResolvedDeck> }): ResolutionMap {
  return { decks: new Map([...resolution.decks].map(([key, deck]) => [key, { ...deck, code: code(deck.code as never) }])) }
}

export async function resolve(input: { manifest: DeckManifest; config: FetchConfig; lockfile?: Lockfile; workspaces?: Map<string, DeckManifest> }): Promise<ResolutionMap> {
  const workspaces = new Map(
    [...(input.workspaces ?? new Map<string, DeckManifest>())].map(([name, manifest]) => [
      name,
      { manifest: portManifest(manifest as never), ...('dir' in manifest && typeof manifest.dir === 'string' ? { dir: manifest.dir } : {}) },
    ]),
  )
  const lock = input.lockfile ? { form: 'some', value: portLock(input.lockfile) } : { form: 'none' }
  const answer = await refused(() => port.resolve(portManifest(input.manifest as never) as never, input.config, lock as never, workspaces as never))

  return fromPort(answer as never)
}

export function buildLockfile(input: { resolution: ResolutionMap }): Lockfile {
  const resolution = { decks: new Map([...input.resolution.decks].map(([key, deck]) => [key, { ...deck, code: portCode(deck.code) }])) }
  const lock = port.buildLockfile(resolution as never) as never as Lockfile

  return { ...lock, decks: lock.decks.map(d => ({ ...d, code: code(d.code as never) })) }
}
