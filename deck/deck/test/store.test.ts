import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { getFilePath, getStoreRoot, getTreeDir } from '../code/store'

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
  it('lives under home directory', () => {
    const root = getStoreRoot()
    expect(root).toBe(path.join(os.homedir(), '.base/@cluesurf/term'))
  })
})

describe('getTreeDir', () => {
  it('is tree/ under store root', () => {
    const dir = getTreeDir()
    expect(dir).toBe(path.join(os.homedir(), '.base/@cluesurf/term', 'tree'))
  })
})
