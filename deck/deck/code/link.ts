import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { ResolutionMap, ResolvedDeck, Mark } from './form'
import { showMark } from './mark'
import { getFilePath, initStore } from './store'
import { hashBuffer } from './hash'
import { fetchTarball } from './fetch'
import { verifyHash } from './hash'
import { FetchConfig } from './form'

const LINK_DIR = 'link'
const SEED_DIR = '.seed'

export async function linkPackages(input: {
  root: string
  resolution: ResolutionMap
  config: FetchConfig
}): Promise<void> {
  const linkDir = path.join(input.root, LINK_DIR)
  const seedDir = path.join(linkDir, SEED_DIR)

  await fsp.mkdir(linkDir, { recursive: true })
  await fsp.mkdir(seedDir, { recursive: true })
  await initStore()

  // install each resolved package to the flat store
  const tasks: Promise<void>[] = []
  const chunks = chunkArray(
    Array.from(input.resolution.decks.values()),
    input.config.concurrency,
  )

  for (const chunk of chunks) {
    const chunkTasks = chunk.map(resolved =>
      installResolved({
        resolved,
        seedDir,
        config: input.config,
      }),
    )

    await Promise.all(chunkTasks)
  }

  // create top-level symlinks for direct dependencies
  for (const resolved of input.resolution.decks.values()) {
    await createTopLink({
      linkDir,
      seedDir,
      resolved,
    })
  }

  // create per-package dependency symlinks
  for (const resolved of input.resolution.decks.values()) {
    await createDepLinks({
      seedDir,
      resolved,
      resolution: input.resolution,
    })
  }
}

async function installResolved(input: {
  resolved: ResolvedDeck
  seedDir: string
  config: FetchConfig
}): Promise<void> {
  const { resolved, seedDir } = input
  const markStr = showMark(resolved.mark)
  const deckDir = path.join(seedDir, `${resolved.name}@${markStr}`)

  // skip if already installed
  try {
    await fsp.access(deckDir)

    return
  } catch {
    // not installed yet
  }

  // skip workspace packages (no tarball)
  if (!resolved.site) {return}

  // fetch tarball
  const tarball = await fetchTarball({
    url: resolved.site,
    config: input.config,
  })

  // verify integrity
  if (resolved.hash) {
    const expected = resolved.hash.replace(/^sha512-/, '')
    const actual = await hashBuffer({ data: tarball })
    // npm uses base64-encoded sha512, we use hex
    // try hex comparison first, then base64
    const actualBase64 =
      tarball.length > 0
        ? (await import('crypto'))
            .createHash('sha512')
            .update(tarball)
            .digest('base64')
        : ''

    if (actual !== expected && actualBase64 !== expected) {
      throw new Error(
        `Integrity check failed for ${resolved.name}@${showMark(resolved.mark)}. ` +
          `Expected ${expected}, got ${actual}`,
      )
    }
  }

  // extract tarball to store and hard-link to package dir
  await extractAndLink({
    tarball,
    deckDir,
  })
}

async function extractAndLink(input: {
  tarball: Buffer
  deckDir: string
}): Promise<void> {
  const { tarball, deckDir } = input

  await fsp.mkdir(deckDir, { recursive: true })

  // use tar to extract (Node.js built-in via child_process)
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  // write tarball to temp file
  const tmpFile = `${deckDir}.tgz`
  await fsp.writeFile(tmpFile, tarball)

  try {
    await execFileAsync('tar', [
      'xzf',
      tmpFile,
      '-C',
      deckDir,
      '--strip-components=1',
    ])
  } finally {
    await fsp.unlink(tmpFile).catch(() => {})
  }

  // hard-link files to content-addressed store
  await hardLinkToStore({ dir: deckDir })
}

async function hardLinkToStore(input: { dir: string }): Promise<void> {
  const entries = await fsp.readdir(input.dir, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    const fullPath = path.join(input.dir, entry.name)

    if (entry.isDirectory()) {
      await hardLinkToStore({ dir: fullPath })
      continue
    }

    if (entry.isFile()) {
      const data = await fsp.readFile(fullPath)
      const hash = await hashBuffer({ data })
      const storePath = getFilePath({ hash })
      const storeDir = path.dirname(storePath)

      await fsp.mkdir(storeDir, { recursive: true })

      try {
        await fsp.access(storePath)
      } catch {
        // file not in store yet, move it there
        await fsp.writeFile(storePath, data)
      }

      // replace original with hard link
      await fsp.unlink(fullPath)
      await fsp.link(storePath, fullPath)
    }
  }
}

async function createTopLink(input: {
  linkDir: string
  seedDir: string
  resolved: ResolvedDeck
}): Promise<void> {
  const { linkDir, seedDir, resolved } = input
  const markStr = showMark(resolved.mark)
  const deckDir = path.join(seedDir, `${resolved.name}@${markStr}`)

  // parse scope from name
  const parts = resolved.name.split('/')

  let targetLink: string

  if (parts.length === 2) {
    // scoped: @scope/name -> link/@scope/name
    const scopeDir = path.join(linkDir, parts[0]!)
    await fsp.mkdir(scopeDir, { recursive: true })
    targetLink = path.join(scopeDir, parts[1]!)
  } else {
    targetLink = path.join(linkDir, resolved.name)
  }

  // remove existing symlink
  await fsp.rm(targetLink, { force: true })

  // create relative symlink
  const relative = path.relative(path.dirname(targetLink), deckDir)
  await fsp.symlink(relative, targetLink)
}

async function createDepLinks(input: {
  seedDir: string
  resolved: ResolvedDeck
  resolution: ResolutionMap
}): Promise<void> {
  const { seedDir, resolved, resolution } = input
  const markStr = showMark(resolved.mark)
  const deckDir = path.join(seedDir, `${resolved.name}@${markStr}`)
  const depsLinkDir = path.join(deckDir, LINK_DIR)

  if (resolved.link.size === 0) {return}

  await fsp.mkdir(depsLinkDir, { recursive: true })

  for (const [depName] of resolved.link) {
    // find the resolved version of this dependency
    const depResolved = findResolvedDep({
      name: depName,
      resolution,
    })

    if (!depResolved) {continue}

    const depMarkStr = showMark(depResolved.mark)
    const depDeckDir = path.join(seedDir, `${depName}@${depMarkStr}`)

    // parse scope
    const parts = depName.split('/')

    let targetLink: string

    if (parts.length === 2) {
      const scopeDir = path.join(depsLinkDir, parts[0]!)
      await fsp.mkdir(scopeDir, { recursive: true })
      targetLink = path.join(scopeDir, parts[1]!)
    } else {
      targetLink = path.join(depsLinkDir, depName)
    }

    await fsp.rm(targetLink, { force: true })

    const relative = path.relative(path.dirname(targetLink), depDeckDir)
    await fsp.symlink(relative, targetLink)
  }
}

function findResolvedDep(input: {
  name: string
  resolution: ResolutionMap
}): ResolvedDeck | undefined {
  for (const resolved of input.resolution.decks.values()) {
    if (resolved.name === input.name) {
      return resolved
    }
  }

  return undefined
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }

  return chunks
}

export async function cleanLinks(input: {
  root: string
}): Promise<void> {
  const linkDir = path.join(input.root, LINK_DIR)
  await fsp.rm(linkDir, { recursive: true, force: true })
}

export async function devLink(input: {
  root: string
  packageDir: string
}): Promise<void> {
  const { loadManifest } = await import('./manifest')
  const manifest = await loadManifest({ dir: input.packageDir })
  const fullName = manifest.host
    ? `@${manifest.host}/${manifest.name}`
    : manifest.name

  const linkDir = path.join(input.root, LINK_DIR)
  const parts = fullName.split('/')

  let targetLink: string

  if (parts.length === 2) {
    const scopeDir = path.join(linkDir, parts[0]!)
    await fsp.mkdir(scopeDir, { recursive: true })
    targetLink = path.join(scopeDir, parts[1]!)
  } else {
    await fsp.mkdir(linkDir, { recursive: true })
    targetLink = path.join(linkDir, fullName)
  }

  await fsp.rm(targetLink, { force: true })
  await fsp.symlink(path.resolve(input.packageDir), targetLink)
}

export async function devUnlink(input: {
  root: string
  name: string
}): Promise<void> {
  const linkDir = path.join(input.root, LINK_DIR)
  const parts = input.name.split('/')

  let targetLink: string

  if (parts.length === 2) {
    targetLink = path.join(linkDir, parts[0]!, parts[1]!)
  } else {
    targetLink = path.join(linkDir, input.name)
  }

  await fsp.rm(targetLink, { force: true })
}
