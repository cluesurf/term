import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { findWorkspaces, topologicalSort } from '../code/workspace'
import { DeckManifest } from '../code/form'

describe('topologicalSort', () => {
  it('sorts independent packages', () => {
    const workspaces = new Map<string, DeckManifest>([
      [
        '@cluesurf/a',
        {
          host: 'cluesurf',
          name: 'a',
          code: { major: 1, minor: 0, patch: 0 },
          link: [],
        },
      ],
      [
        '@cluesurf/b',
        {
          host: 'cluesurf',
          name: 'b',
          code: { major: 1, minor: 0, patch: 0 },
          link: [],
        },
      ],
    ])

    const sorted = topologicalSort({ workspaces })
    expect(sorted).toHaveLength(2)
    expect(sorted).toContain('@cluesurf/a')
    expect(sorted).toContain('@cluesurf/b')
  })

  it('sorts dependent packages in correct order', () => {
    const workspaces = new Map<string, DeckManifest>([
      [
        '@cluesurf/app',
        {
          host: 'cluesurf',
          name: 'app',
          code: { major: 1, minor: 0, patch: 0 },
          link: [
            {
              name: '@cluesurf/shared',
              code: { form: 'wild', major: 1 },
            },
          ],
        },
      ],
      [
        '@cluesurf/shared',
        {
          host: 'cluesurf',
          name: 'shared',
          code: { major: 1, minor: 0, patch: 0 },
          link: [],
        },
      ],
    ])

    const sorted = topologicalSort({ workspaces })
    expect(sorted).toEqual(['@cluesurf/shared', '@cluesurf/app'])
  })

  it('handles diamond dependencies', () => {
    const workspaces = new Map<string, DeckManifest>([
      [
        '@cluesurf/app',
        {
          host: 'cluesurf',
          name: 'app',
          code: { major: 1, minor: 0, patch: 0 },
          link: [
            {
              name: '@cluesurf/web',
              code: { form: 'wild', major: 1 },
            },
            {
              name: '@cluesurf/api',
              code: { form: 'wild', major: 1 },
            },
          ],
        },
      ],
      [
        '@cluesurf/web',
        {
          host: 'cluesurf',
          name: 'web',
          code: { major: 1, minor: 0, patch: 0 },
          link: [
            {
              name: '@cluesurf/shared',
              code: { form: 'wild', major: 1 },
            },
          ],
        },
      ],
      [
        '@cluesurf/api',
        {
          host: 'cluesurf',
          name: 'api',
          code: { major: 1, minor: 0, patch: 0 },
          link: [
            {
              name: '@cluesurf/shared',
              code: { form: 'wild', major: 1 },
            },
          ],
        },
      ],
      [
        '@cluesurf/shared',
        {
          host: 'cluesurf',
          name: 'shared',
          code: { major: 1, minor: 0, patch: 0 },
          link: [],
        },
      ],
    ])

    const sorted = topologicalSort({ workspaces })
    expect(sorted).toHaveLength(4)

    const sharedIdx = sorted.indexOf('@cluesurf/shared')
    const webIdx = sorted.indexOf('@cluesurf/web')
    const apiIdx = sorted.indexOf('@cluesurf/api')
    const appIdx = sorted.indexOf('@cluesurf/app')

    expect(sharedIdx).toBeLessThan(webIdx)
    expect(sharedIdx).toBeLessThan(apiIdx)
    expect(webIdx).toBeLessThan(appIdx)
    expect(apiIdx).toBeLessThan(appIdx)
  })
})

// Which decks a project installs from its workspace rather than a registry (`findWorkspaces`): from the workspace
// root, from inside one member, and never from a `deck/` folder that is not a workspace's.
function deck(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'deck.tree'), `deck ${name}\n  mark <1.0.0>\n`)
}

describe('findWorkspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'term-workspace-'))
  const workspace = join(root, 'repo')

  deck(workspace, '@alice/repo')
  deck(join(workspace, 'deck', 'base'), '@alice/base')
  deck(join(workspace, 'deck', 'face'), '@alice/face')
  deck(join(workspace, 'deck', 'face', 'deck', 'inner'), '@alice/inner')

  it('finds every member from the workspace root', async () => {
    const found = await findWorkspaces({ root: workspace })

    expect([...found.keys()].sort()).toEqual(['@alice/base', '@alice/face'])
  })

  it('finds the siblings from inside one member, so a link to one installs its source', async () => {
    const found = await findWorkspaces({ root: join(workspace, 'deck', 'face') })

    expect(found.get('@alice/base')?.dir).toBe(join(workspace, 'deck', 'base'))
    // and the member's own nested decks besides
    expect(found.has('@alice/inner')).toBe(true)
  })

  it('does not take a `deck/` folder for a workspace when its parent holds no deck.tree', async () => {
    const plain = join(root, 'plain')

    deck(join(plain, 'deck', 'solo'), '@alice/solo')
    deck(join(plain, 'deck', 'other'), '@alice/other')

    expect([...(await findWorkspaces({ root: join(plain, 'deck', 'solo') })).keys()]).toEqual([])
  })
})
