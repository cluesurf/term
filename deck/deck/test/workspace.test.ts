import { describe, it, expect } from 'vitest'
import { topologicalSort } from '../code/workspace'
import { DeckManifest } from '../code/form'

describe('topologicalSort', () => {
  it('sorts independent packages', () => {
    const workspaces = new Map<string, DeckManifest>([
      [
        '@cluesurf/a',
        {
          host: 'cluesurf',
          name: 'a',
          mark: { major: 1, minor: 0, patch: 0 },
          link: [],
        },
      ],
      [
        '@cluesurf/b',
        {
          host: 'cluesurf',
          name: 'b',
          mark: { major: 1, minor: 0, patch: 0 },
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
          mark: { major: 1, minor: 0, patch: 0 },
          link: [
            {
              name: '@cluesurf/shared',
              mark: { form: 'wild', major: 1 },
            },
          ],
        },
      ],
      [
        '@cluesurf/shared',
        {
          host: 'cluesurf',
          name: 'shared',
          mark: { major: 1, minor: 0, patch: 0 },
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
          mark: { major: 1, minor: 0, patch: 0 },
          link: [
            {
              name: '@cluesurf/web',
              mark: { form: 'wild', major: 1 },
            },
            {
              name: '@cluesurf/api',
              mark: { form: 'wild', major: 1 },
            },
          ],
        },
      ],
      [
        '@cluesurf/web',
        {
          host: 'cluesurf',
          name: 'web',
          mark: { major: 1, minor: 0, patch: 0 },
          link: [
            {
              name: '@cluesurf/shared',
              mark: { form: 'wild', major: 1 },
            },
          ],
        },
      ],
      [
        '@cluesurf/api',
        {
          host: 'cluesurf',
          name: 'api',
          mark: { major: 1, minor: 0, patch: 0 },
          link: [
            {
              name: '@cluesurf/shared',
              mark: { form: 'wild', major: 1 },
            },
          ],
        },
      ],
      [
        '@cluesurf/shared',
        {
          host: 'cluesurf',
          name: 'shared',
          mark: { major: 1, minor: 0, patch: 0 },
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
