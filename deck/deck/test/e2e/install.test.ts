import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import http from 'http'
import {
  resolve,
  buildLockfile,
  cleanLinks,
  devLink,
  devUnlink,
  loadManifest,
  writeManifest,
  parseManifest,
  verifyInstall,
  validateManifest,
  showCode,
  parseCodeHold,
  makeDefaultFetchConfig,
} from '@/index'
import type { DeckManifest, FetchConfig, RegistryPackageMeta } from '@/form'

let server: http.Server
let serverPort: number
let tmpBase: string

// in-memory package registry
const registry = new Map<string, RegistryPackageMeta>()

function makeConfig(): FetchConfig {
  return {
    registry: `http://localhost:${serverPort}`,
    concurrency: 4,
    offline: false,
  }
}

async function makeTmpDir(name: string): Promise<string> {
  const dir = path.join(tmpBase, name)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

async function writeDecktree(dir: string, content: string): Promise<void> {
  await fsp.writeFile(path.join(dir, 'deck.tree'), content, 'utf-8')
}

function addPackage(input: {
  name: string
  version: string
  dependencies?: Record<string, string>
  tarballUrl?: string
}): void {
  let meta = registry.get(input.name)
  if (!meta) {
    meta = {
      name: input.name,
      versions: {},
      'dist-tags': {},
    }
    registry.set(input.name, meta)
  }

  meta.versions[input.version] = {
    dist: {
      shasum: 'abc123',
      tarball: input.tarballUrl ?? `http://localhost:${serverPort}/${input.name}/-/${input.name}-${input.version}.tgz`,
      integrity: '',
    },
    dependencies: input.dependencies,
  }
  meta['dist-tags'].latest = input.version
}

// create a minimal valid tarball (gzipped tar with package/index.js)
async function makeTarball(input: {
  name: string
  version: string
}): Promise<Buffer> {
  const dir = await makeTmpDir(`tgz-${input.name}-${input.version}`)
  const pkgDir = path.join(dir, 'package')
  await fsp.mkdir(pkgDir, { recursive: true })
  await fsp.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: input.name, version: input.version }),
  )
  await fsp.writeFile(
    path.join(pkgDir, 'index.js'),
    `module.exports = { name: '${input.name}' }\n`,
  )

  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)
  const tgzPath = path.join(dir, 'pkg.tgz')
  await exec('tar', ['czf', tgzPath, '-C', dir, 'package'])
  return fsp.readFile(tgzPath)
}

// pre-built tarballs cache
const tarballs = new Map<string, Buffer>()

beforeAll(async () => {
  tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-e2e-'))

  // find free port and start mock registry
  await new Promise<void>((res, rej) => {
    server = http.createServer(async (req, resp) => {
      const url = req.url ?? '/'

      // tarball download
      if (url.endsWith('.tgz')) {
        const key = url.replace(/^\//, '').replace(/\/-\//, '/')
        const data = tarballs.get(key)
        if (data) {
          resp.writeHead(200, { 'Content-Type': 'application/gzip' })
          resp.end(data)
          return
        }
        resp.writeHead(404)
        resp.end('Not found')
        return
      }

      // package metadata
      const pkgName = url.replace(/^\//, '').replace(/%2f/gi, '/')
      const meta = registry.get(pkgName)
      if (meta) {
        resp.writeHead(200, { 'Content-Type': 'application/json' })
        resp.end(JSON.stringify(meta))
        return
      }

      resp.writeHead(404)
      resp.end(JSON.stringify({ error: 'Not found' }))
    })

    server.listen(0, () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        serverPort = addr.port
      }
      res()
    })

    server.on('error', rej)
  })

  // seed the registry with test packages
  // the registry is keyed by the bare package name: `fetch.ts` requests `${registry}/${name}` with no `.tree`
  // suffix, so the fixture has to register under that same bare name
  addPackage({ name: 'seed-e2e-leaf-a', version: '1.0.0' })
  addPackage({ name: 'seed-e2e-leaf-a', version: '1.0.2' })
  addPackage({ name: 'seed-e2e-leaf-a', version: '1.2.0' })
  addPackage({ name: 'seed-e2e-leaf-a', version: '2.0.0' })

  addPackage({ name: 'seed-e2e-leaf-b', version: '0.1.0' })
  addPackage({ name: 'seed-e2e-leaf-b', version: '0.2.0' })

  addPackage({
    name: 'seed-e2e-mid-c',
    version: '1.0.0',
    dependencies: { 'seed-e2e-leaf-a': '^1.0.0' },
  })

  addPackage({
    name: 'seed-e2e-top-d',
    version: '1.0.0',
    dependencies: {
      'seed-e2e-mid-c': '^1.0.0',
      'seed-e2e-leaf-b': '^0.1.0',
    },
  })

  // build tarballs for packages that need to be installed
  for (const [name, meta] of registry) {
    for (const version of Object.keys(meta.versions)) {
      const tarball = await makeTarball({ name, version })
      const key = `${name}/-/${name}-${version}.tgz`
      tarballs.set(key, tarball)
    }
  }
}, 30000)

afterAll(async () => {
  server?.close()
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
})

describe('resolve', () => {
  test('resolves a single direct dependency', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-leaf-a', code: parseCodeHold('1.x.x') },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })

    expect(result.decks.size).toBeGreaterThanOrEqual(1)
    const leafA = Array.from(result.decks.values()).find(d => d.name === 'seed-e2e-leaf-a')
    expect(leafA).toBeDefined()
    expect(leafA!.code.major).toBe(1)
  })

  test('resolves wildcard to latest matching version', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-leaf-a', code: parseCodeHold('1.x.x') },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })
    const leafA = Array.from(result.decks.values()).find(d => d.name === 'seed-e2e-leaf-a')
    expect(leafA).toBeDefined()
    // should pick 1.2.0 (latest 1.x.x)
    expect(leafA!.code.minor).toBe(2)
    expect(leafA!.code.patch).toBe(0)
  })

  test('resolves exact version', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        {
          name: 'seed-e2e-leaf-a',
          code: { form: 'exact', code: { major: 1, minor: 0, patch: 2 } },
        },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })
    const leafA = Array.from(result.decks.values()).find(d => d.name === 'seed-e2e-leaf-a')
    expect(leafA).toBeDefined()
    expect(showCode(leafA!.code)).toBe('1.0.2')
  })

  test('resolves transitive dependencies', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-mid-c', code: parseCodeHold('1.x.x') },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })
    const names = Array.from(result.decks.values()).map(d => d.name)
    expect(names).toContain('seed-e2e-mid-c')
    expect(names).toContain('seed-e2e-leaf-a')
  })

  test('resolves deep transitive dependencies', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-top-d', code: parseCodeHold('1.x.x') },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })
    const names = Array.from(result.decks.values()).map(d => d.name)
    expect(names).toContain('seed-e2e-top-d')
    expect(names).toContain('seed-e2e-mid-c')
    expect(names).toContain('seed-e2e-leaf-a')
    expect(names).toContain('seed-e2e-leaf-b')
  })

  test('throws on non-existent package', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-does-not-exist', code: parseCodeHold('1.x.x') },
      ],
    }

    await expect(
      resolve({ manifest, config: makeConfig() }),
    ).rejects.toThrow()
  })

  test('throws on no matching version', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-leaf-a', code: parseCodeHold('99.x.x') },
      ],
    }

    await expect(
      resolve({ manifest, config: makeConfig() }),
    ).rejects.toThrow('No version')
  })

  test('resolves multiple direct dependencies', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-leaf-a', code: parseCodeHold('1.x.x') },
        { name: 'seed-e2e-leaf-b', code: parseCodeHold('0.x.x') },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })
    const names = Array.from(result.decks.values()).map(d => d.name)
    expect(names).toContain('seed-e2e-leaf-a')
    expect(names).toContain('seed-e2e-leaf-b')
  })

  test('resolves band constraint', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-leaf-a', code: parseCodeHold('1.0.0..1.1.0') },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })
    const leafA = Array.from(result.decks.values()).find(d => d.name === 'seed-e2e-leaf-a')
    expect(leafA).toBeDefined()
    // should pick 1.0.2 (latest in range 1.0.0..1.1.0)
    expect(leafA!.code.major).toBe(1)
    expect(leafA!.code.minor).toBe(0)
  })
})

describe('lockfile', () => {
  test('buildLockfile creates valid lockfile from resolution', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-mid-c', code: parseCodeHold('1.x.x') },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })
    const lockfile = buildLockfile({ resolution: result })

    expect(lockfile.version).toBe(1)
    expect(lockfile.decks.length).toBeGreaterThanOrEqual(2)

    const midC = lockfile.decks.find(d => d.name === 'seed-e2e-mid-c')
    expect(midC).toBeDefined()
    expect(midC!.site).toContain('http')
  })

  test('lockfile preserves resolved versions on re-resolve', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-leaf-a', code: parseCodeHold('1.x.x') },
      ],
    }

    const config = makeConfig()
    const resolution1 = await resolve({ manifest, config })
    const lockfile = buildLockfile({ resolution: resolution1 })

    const resolution2 = await resolve({ manifest, config, lockfile })

    const v1 = Array.from(resolution1.decks.values()).find(d => d.name === 'seed-e2e-leaf-a')
    const v2 = Array.from(resolution2.decks.values()).find(d => d.name === 'seed-e2e-leaf-a')
    expect(showCode(v1!.code)).toBe(showCode(v2!.code))
  })

  test('lockfile includes transitive dependency metadata', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-top-d', code: parseCodeHold('1.x.x') },
      ],
    }

    const result = await resolve({ manifest, config: makeConfig() })
    const lockfile = buildLockfile({ resolution: result })

    const topD = lockfile.decks.find(d => d.name === 'seed-e2e-top-d')
    expect(topD).toBeDefined()
    expect(topD!.link.length).toBe(2)
    const depNames = topD!.link.map(l => l.name)
    expect(depNames).toContain('seed-e2e-mid-c')
    expect(depNames).toContain('seed-e2e-leaf-b')
  })
})

describe('manifest', () => {
  test('parseManifest and writeManifest round-trip', () => {
    const text = [
      'deck @myorg/mypackage',
      '  code <1.2.4>',
      '  head <A test package>',
      '  link seed-e2e-leaf-a, code <1.x.x>',
      '  link seed-e2e-leaf-b, code <0.1.0..1.0.0>',
    ].join('\n')

    const manifest = parseManifest({ text })
    expect(manifest.host).toBe('myorg')
    expect(manifest.name).toBe('mypackage')
    expect(manifest.code).toEqual({ major: 1, minor: 2, patch: 4 })
    expect(manifest.link.length).toBe(2)

    const written = writeManifest({ manifest })
    const reparsed = parseManifest({ text: written })
    expect(reparsed.host).toBe('myorg')
    expect(reparsed.name).toBe('mypackage')
    expect(reparsed.link.length).toBe(2)
  })

  test('parseManifest handles unscoped package', () => {
    const text = [
      'deck simple-pkg',
      '  code <0.1.0>',
    ].join('\n')

    const manifest = parseManifest({ text })
    expect(manifest.host).toBe('')
    expect(manifest.name).toBe('simple-pkg')
  })

  test('parseManifest reads hooks', () => {
    const text = [
      'deck test-pkg',
      '  code <1.0.0>',
      '  hook build, task tsc',
      '  hook test, task vitest run',
    ].join('\n')

    const manifest = parseManifest({ text })
    expect(manifest.hook).toBeDefined()
    expect(manifest.hook!.build).toBe('tsc')
    expect(manifest.hook!.test).toBe('vitest run')
  })
})

describe('devLink and devUnlink', () => {
  test('devLink creates symlink to local package', async () => {
    const projectDir = await makeTmpDir(`devlink-project-${Date.now()}`)
    const localPkgDir = await makeTmpDir(`devlink-pkg-${Date.now()}`)

    await writeDecktree(projectDir, 'deck test-project\n  code <0.1.0>')
    await writeDecktree(localPkgDir, 'deck @myorg/local-pkg\n  code <0.1.0>')

    await devLink({ root: projectDir, packageDir: localPkgDir })

    const linkPath = path.join(projectDir, 'link', '@myorg', 'local-pkg')
    const stat = await fsp.lstat(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)

    const target = await fsp.readlink(linkPath)
    expect(path.resolve(path.dirname(linkPath), target)).toBe(path.resolve(localPkgDir))
  })

  test('devUnlink removes the symlink', async () => {
    const projectDir = await makeTmpDir(`devunlink-project-${Date.now()}`)
    const localPkgDir = await makeTmpDir(`devunlink-pkg-${Date.now()}`)

    await writeDecktree(projectDir, 'deck test-project\n  code <0.1.0>')
    await writeDecktree(localPkgDir, 'deck @myorg/local-pkg\n  code <0.1.0>')

    await devLink({ root: projectDir, packageDir: localPkgDir })
    await devUnlink({ root: projectDir, name: '@myorg/local-pkg' })

    const linkPath = path.join(projectDir, 'link', '@myorg', 'local-pkg')
    await expect(fsp.lstat(linkPath)).rejects.toThrow()
  })

  test('devLink with unscoped package', async () => {
    const projectDir = await makeTmpDir(`devlink-unscoped-${Date.now()}`)
    const localPkgDir = await makeTmpDir(`devlink-unscoped-pkg-${Date.now()}`)

    await writeDecktree(projectDir, 'deck test-project\n  code <0.1.0>')
    await writeDecktree(localPkgDir, 'deck local-pkg\n  code <0.1.0>')

    await devLink({ root: projectDir, packageDir: localPkgDir })

    const linkPath = path.join(projectDir, 'link', 'local-pkg')
    const stat = await fsp.lstat(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)
  })
})


describe('cleanLinks', () => {
  test('removes the entire link directory', async () => {
    const dir = await makeTmpDir(`clean-${Date.now()}`)
    const linkDir = path.join(dir, 'link')
    await fsp.mkdir(path.join(linkDir, 'some-pkg'), { recursive: true })
    await fsp.writeFile(path.join(linkDir, 'some-pkg', 'index.js'), 'test')

    await cleanLinks({ root: dir })
    await expect(fsp.stat(linkDir)).rejects.toThrow()
  })

  test('cleanLinks is idempotent on missing dir', async () => {
    const dir = await makeTmpDir(`clean-noop-${Date.now()}`)
    // no link dir exists
    await cleanLinks({ root: dir })
    // should not throw
  })
})

describe('offline mode', () => {
  test('resolve throws in offline mode without lockfile', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-leaf-a', code: parseCodeHold('1.x.x') },
      ],
    }

    const config = makeConfig()
    config.offline = true

    await expect(
      resolve({ manifest, config }),
    ).rejects.toThrow('offline')
  })

  test('resolve works offline with lockfile', async () => {
    const manifest: DeckManifest = {
      host: '',
      name: 'test-project',
      code: { major: 0, minor: 1, patch: 0 },
      link: [
        { name: 'seed-e2e-leaf-a', code: parseCodeHold('1.x.x') },
      ],
    }

    // first resolve online to get lockfile
    const config = makeConfig()
    const resolution1 = await resolve({ manifest, config })
    const lockfile = buildLockfile({ resolution: resolution1 })

    // now resolve offline with the lockfile
    config.offline = true
    const resolution2 = await resolve({ manifest, config, lockfile })

    const v1 = Array.from(resolution1.decks.values()).find(d => d.name === 'seed-e2e-leaf-a')
    const v2 = Array.from(resolution2.decks.values()).find(d => d.name === 'seed-e2e-leaf-a')
    expect(showCode(v1!.code)).toBe(showCode(v2!.code))
  })
})
