// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/install.ts had, with
// their shapes, answered by deck/deck/code/package/installing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import type { DeckManifest } from '@term/deck/code/form'
import * as port from '@term/deck/code/package/installing'
import { GRAMMARS, refused } from './grammars'
import { portManifest } from './manifest'

export async function install(input: {
  root: string
  clean?: boolean
  offline?: boolean
}): Promise<{ decks: number; need?: unknown }> {
  return (await refused(() =>
    port.install(
      input.root,
      input.clean ?? false,
      input.offline ?? false,
      GRAMMARS,
    ),
  )) as never
}

export function hostScopeRegistries(input: {
  manifest: DeckManifest
}): Record<string, string> {
  const shaped = portManifest(input.manifest as never) as Record<
    string,
    unknown
  >

  try {
    return Object.fromEntries(
      port.hostScopeRegistries(shaped as never),
    )
  } catch (error) {
    const note = (error as { note?: unknown }).note

    throw typeof note === 'string' ? new Error(note) : error
  }
}

export async function addDependency(input: {
  root: string
  name: string
  constraint?: string
}): Promise<void> {
  await refused(() =>
    port.addDependency(
      input.root,
      input.name,
      input.constraint ?? '',
      GRAMMARS,
    ),
  )
}

export async function removeDependency(input: {
  root: string
  name: string
}): Promise<void> {
  await refused(() =>
    port.removeDependency(input.root, input.name, GRAMMARS),
  )
}

export async function verifyInstall(input: {
  root: string
}): Promise<{ ok: boolean; missing: string[]; outdated: string[] }> {
  return refused(() => port.verifyInstall(input.root))
}
