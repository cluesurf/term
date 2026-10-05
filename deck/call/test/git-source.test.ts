// `gitSource` (call/code/host.ts): the repository address `term host` writes as `org.opencontainers.image.source`,
// which is what links a GHCR package to its repository. It is written into a public manifest, so a credential in an
// https remote must never survive.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { gitSource } from '../code/host'

const made: string[] = []

function repo(remote?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-source-'))

  made.push(dir)
  execFileSync('git', ['init', '-q', dir])

  if (remote) {
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
  }

  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('gitSource', () => {
  it.each([
    ['git@github.com:cluesurf/zone.git', 'https://github.com/cluesurf/zone'],
    ['git@github.com:cluesurf/zone', 'https://github.com/cluesurf/zone'],
    ['ssh://git@github.com/cluesurf/zone.git', 'https://github.com/cluesurf/zone'],
    ['https://github.com/cluesurf/zone.git', 'https://github.com/cluesurf/zone'],
    ['https://x-access-token:ghp_secret@github.com/cluesurf/zone.git', 'https://github.com/cluesurf/zone'],
  ])('reads %s as %s', (remote, source) => {
    expect(gitSource(repo(remote))).toBe(source)
  })

  it('is undefined without an origin', () => {
    expect(gitSource(repo())).toBeUndefined()
  })

  it('is undefined outside a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-source-none-'))

    made.push(dir)
    expect(gitSource(dir)).toBeUndefined()
  })
})
