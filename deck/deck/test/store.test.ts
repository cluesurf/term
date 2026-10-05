import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync } from 'fs'
import path from 'path'
import os from 'os'
import { getFilePath, getStoreRoot, getTreeDir } from '../code/store'

// each case in a home of its own, so what exists on this machine decides nothing
let home = ''
let realHome: string | undefined

beforeEach(() => {
  realHome = process.env.HOME
  home = mkdtempSync(path.join(os.tmpdir(), 'term-store-'))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = realHome
})

describe('getFilePath', () => {
  it('uses 2-char prefix for directory sharding', () => {
    const hash = 'a1b2c3d4e5f6'
    const filePath = getFilePath({ hash })
    const treeDir = getTreeDir()
    expect(filePath).toBe(path.join(treeDir, 'a1', 'a1b2c3d4e5f6'))
  })

  it('uses correct prefix for different hashes', () => {
    const hash = 'ff0011223344'
    const filePath = getFilePath({ hash })
    const treeDir = getTreeDir()
    expect(filePath).toBe(path.join(treeDir, 'ff', 'ff0011223344'))
  })
})

describe('getStoreRoot', () => {
  it('is ~/.base/@term/code on a machine with nothing yet', () => {
    expect(getStoreRoot()).toBe(path.join(home, '.base/@term/code'))
  })

  it('reads the folder from before 2026-10-05 while the CLI has not moved it yet', () => {
    mkdirSync(path.join(home, '.base/@cluesurf/term'), { recursive: true })

    expect(getStoreRoot()).toBe(path.join(home, '.base/@cluesurf/term'))
  })

  it('prefers the new folder once it exists', () => {
    mkdirSync(path.join(home, '.base/@cluesurf/term'), { recursive: true })
    mkdirSync(path.join(home, '.base/@term/code'), { recursive: true })

    expect(getStoreRoot()).toBe(path.join(home, '.base/@term/code'))
  })

  it('reads the folder from before 2026-08-30 when it is the only one', () => {
    mkdirSync(path.join(home, '.base/term'), { recursive: true })

    expect(getStoreRoot()).toBe(path.join(home, '.base/term'))
  })
})

describe('getTreeDir', () => {
  it('is tree/ under store root', () => {
    expect(getTreeDir()).toBe(path.join(home, '.base/@term/code', 'tree'))
  })
})
