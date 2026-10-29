// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/link.ts had, with
// their shapes, answered by deck/deck/code/package/linking.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import type { FetchConfig, ResolutionMap } from '@term/deck/code/form'
import * as port from '@term/deck/code/package/linking'
import { GRAMMARS, refused } from './grammars'

type AnyCode = {
  major: number
  minor: number
  patch: number
  prerelease?: string
  build?: string
}
const portCode = (value: AnyCode) => ({
  major: value.major,
  minor: value.minor,
  patch: value.patch,
  prerelease: value.prerelease ?? '',
  build: value.build ?? '',
})

export async function linkPackages(input: {
  root: string
  resolution: ResolutionMap
  config: FetchConfig
}): Promise<void> {
  const decks = new Map(
    [...input.resolution.decks].map(([key, deck]) => [
      key,
      {
        ...deck,
        code: portCode(deck.code),
        site: deck.site ?? '',
        hash: deck.hash ?? '',
      },
    ]),
  )

  await refused(() =>
    port.linkPackages(input.root, { decks } as never, input.config),
  )
}

export async function cleanLinks(input: {
  root: string
}): Promise<void> {
  await refused(() => port.cleanLinks(input.root))
}

export async function devLink(input: {
  root: string
  packageDir: string
}): Promise<void> {
  await refused(() =>
    port.devLink(input.root, input.packageDir, GRAMMARS),
  )
}

export async function devUnlink(input: {
  root: string
  name: string
}): Promise<void> {
  await refused(() => port.devUnlink(input.root, input.name))
}

export async function registerGlobalLink(input: {
  packageDir: string
}): Promise<string> {
  return refused(() =>
    port.registerGlobalLink(input.packageDir, GRAMMARS),
  )
}

export async function unregisterGlobalLink(input: {
  name: string
}): Promise<void> {
  await refused(() => port.unregisterGlobalLink(input.name))
}

export async function listGlobalLinks(): Promise<string[]> {
  return refused(() => port.listGlobalLinks())
}

export async function consumeGlobalLink(input: {
  root: string
  name: string
}): Promise<boolean> {
  return refused(() => port.consumeGlobalLink(input.root, input.name))
}
