// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/lock.ts had, with
// their shapes, answered by deck/deck/code/package/lockfile-reading.tree. The logic is Term; this file only converts shapes for TypeScript callers.
import type { Lockfile } from '@term/deck/code/form'
import * as port from '@term/deck/code/package/lockfile-reading'
import { GRAMMARS, refused, refusedNow } from './grammars'
import { code } from './manifest'


type AnyCode = { major: number; minor: number; patch: number; prerelease?: string; build?: string }
type PortCode = { major: number; minor: number; patch: number; prerelease: string; build: string }
type PortLockfile = { version: number; decks: { code: PortCode; key?: string }[]; need?: { code: PortCode } }

const toPortCode = (c: AnyCode): PortCode => ({ major: c.major, minor: c.minor, patch: c.patch, prerelease: c.prerelease ?? '', build: c.build ?? '' })

export function fromPort(lockfile: PortLockfile): Lockfile {
  return {
    version: lockfile.version,
    decks: lockfile.decks.map(entry => ({ ...entry, code: code(entry.code) })),
    ...(lockfile.need ? { need: { ...lockfile.need, code: code(lockfile.need.code) } } : {}),
  } as Lockfile
}

export function toPort(lockfile: Lockfile): PortLockfile {
  return {
    version: lockfile.version,
    decks: lockfile.decks.map(entry => ({ ...entry, code: toPortCode(entry.code) })),
    ...(lockfile.need ? { need: { ...lockfile.need, code: toPortCode(lockfile.need.code) } } : {}),
  } as PortLockfile
}

export async function loadLockfile(input: { dir: string }): Promise<Lockfile | undefined> {
  const found = (await port.loadLockfile(input.dir, GRAMMARS)) as { form: string; value?: PortLockfile }

  return found.form === 'some' ? fromPort(found.value!) : undefined
}

export function parseLockfile(input: { text: string }): Lockfile {
  return fromPort(refusedNow(() => port.parseLockfile(input.text, GRAMMARS)) as PortLockfile)
}

export function parseLockfileByHand(input: { text: string }): Lockfile {
  return fromPort(refusedNow(() => port.parseLockfileByHand(input.text)) as PortLockfile)
}

export function writeLockfile(input: { lockfile: Lockfile }): string {
  return port.writeLockfile(toPort(input.lockfile) as never)
}

export async function saveLockfile(input: { dir: string; lockfile: Lockfile }): Promise<void> {
  await refused(() => port.saveLockfile(input.dir, toPort(input.lockfile) as never))
}
