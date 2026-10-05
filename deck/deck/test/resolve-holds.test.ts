// One version of a deck is installed, so every link to it must accept the version the first one picked. Two that do
// not were kept the first and dropped the second without a word (guides: packages/install, 2026-10-04). Workspace
// decks, so nothing is fetched.
import { describe, it, expect } from 'vitest'
import { resolve } from '../code/resolve'
import { makeDefaultFetchConfig } from '../code/fetch'
import { parseCode, parseCodeHold } from '../code/code'
import type { DeckManifest } from '../code/form'

const deck = (name: string, mark: string, link: { name: string; hold: string }[] = []): DeckManifest =>
  ({
    name,
    mark: parseCode(mark),
    link: link.map(one => ({ name: one.name, mark: parseCodeHold(one.hold) })),
  }) as unknown as DeckManifest

describe('two links to one deck', () => {
  const tools = deck('@alice/tools', '1.0.0')

  it('resolve when both accept the version picked', async () => {
    const shelf = deck('@bob/shelf', '0.1.0', [{ name: '@alice/tools', hold: '1.x.x' }])
    const project = deck('@probe/app', '0.0.1', [
      { name: '@alice/tools', hold: '1.x.x' },
      { name: '@bob/shelf', hold: '0.x.x' },
    ])

    const resolution = await resolve({
      manifest: project,
      config: makeDefaultFetchConfig(),
      workspaces: new Map([
        ['@alice/tools', tools],
        ['@bob/shelf', shelf],
      ]),
    })

    expect([...resolution.decks.values()].map(one => one.name).sort()).toEqual(['@alice/tools', '@bob/shelf'])
  })

  it('are refused when they accept no version in common, naming both', async () => {
    const shelf = deck('@bob/shelf', '0.1.0', [{ name: '@alice/tools', hold: '2.x.x' }])
    const project = deck('@probe/app', '0.0.1', [
      { name: '@alice/tools', hold: '1.x.x' },
      { name: '@bob/shelf', hold: '0.x.x' },
    ])

    await expect(
      resolve({
        manifest: project,
        config: makeDefaultFetchConfig(),
        workspaces: new Map([
          ['@alice/tools', tools],
          ['@bob/shelf', shelf],
        ]),
      }),
    ).rejects.toThrow(/@alice\/tools: deck\.tree accepts 1\.x\.x and @bob\/shelf accepts 2\.x\.x/)
  })
})
