import { describe, it, expect } from 'vitest'
import { validateManifest } from '../code/manifest'
import { DeckManifest } from '../code/form'

describe('validateManifest', () => {
  it('passes valid manifest', async () => {
    const manifest: DeckManifest = {
      host: 'cluesurf',
      name: 'seed',
      code: { major: 1, minor: 0, patch: 2 },
      link: [],
    }
    const errors = await validateManifest({ manifest })
    expect(errors).toEqual([])
  })

  it('fails on missing name', async () => {
    const manifest: DeckManifest = {
      host: 'cluesurf',
      name: '',
      code: { major: 1, minor: 0, patch: 2 },
      link: [],
    }
    const errors = await validateManifest({ manifest })
    expect(errors).toContain('Missing package name')
  })

  it('fails on 0.0.0 version', async () => {
    const manifest: DeckManifest = {
      host: 'cluesurf',
      name: 'seed',
      code: { major: 0, minor: 0, patch: 0 },
      link: [],
    }
    const errors = await validateManifest({ manifest })
    expect(errors).toContain('Version must be set (not 0.0.0)')
  })

  it('fails on odd patch number', async () => {
    const manifest: DeckManifest = {
      host: 'cluesurf',
      name: 'seed',
      code: { major: 1, minor: 0, patch: 3 },
      link: [],
    }
    const errors = await validateManifest({ manifest })
    expect(errors).toContain(
      'Published versions must use even patch numbers',
    )
  })

  it('passes even patch number', async () => {
    const manifest: DeckManifest = {
      host: 'cluesurf',
      name: 'seed',
      code: { major: 1, minor: 0, patch: 4 },
      link: [],
    }
    const errors = await validateManifest({ manifest })
    expect(errors).toEqual([])
  })
})
