import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { ResolutionMap, ResolvedDeck, Code } from './form'
import { showCode } from './code'
import { getFilePath, initStore, getStoreRoot } from './store'
import { hashBuffer } from './hash'
import { fetchTarball } from './fetch'
import { verifyHash } from './hash'
import { FetchConfig } from './form'

const LINK_DIR = 'link'
const SEED_DIR = '.base/term'

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
  const codeStr = showCode(resolved.code)
  const deckDir = path.join(seedDir, `${resolved.name}@${codeStr}`)

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

  // verify integrity. The registry declares the digest algorithm in
  // the integrity prefix (`sha256-…` or `sha512-…`), so verify with
  // THAT algorithm rather than assuming sha512 (the base.surf registry
  // stores sha256). Accept hex or base64 encoding (npm uses base64,
  // this registry uses hex).
  if (resolved.hash) {
    const parsed = /^(sha256|sha512)-(.+)$/.exec(resolved.hash)
    const algo = parsed ? parsed[1]! : 'sha512'
    const expected = parsed ? parsed[2]! : resolved.hash
    const crypto = await import('crypto')
    const actualHex = crypto.createHash(algo).update(tarball).digest('hex')
    const actualBase64 = crypto
      .createHash(algo)
      .update(tarball)
      .digest('base64')

    if (actualHex !== expected && actualBase64 !== expected) {
      throw new Error(
        `Integrity check failed for ${resolved.name}@${showCode(resolved.code)}. ` +
          `Expected ${resolved.hash}, got ${algo}-${actualHex}`,
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
  const codeStr = showCode(resolved.code)
  const deckDir = path.join(seedDir, `${resolved.name}@${codeStr}`)

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
  const codeStr = showCode(resolved.code)
  const deckDir = path.join(seedDir, `${resolved.name}@${codeStr}`)
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

    const depMarkStr = showCode(depResolved.code)
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

// the global link registry lives at ~/.base/term/link/<name>, a symlink to a package's working directory. `seed link` (no
// argument) registers the current package there; `seed link <name>` symlinks a registered package into a project. This
// is the two-step `npm link` model: register once globally, consume from any project.
function globalLinkPath(fullName: string): string {
  return path.join(getStoreRoot(), 'link', ...fullName.split('/'))
}

// register the package at `packageDir` in the global link registry, keyed by its manifest name. Returns the full name.
export async function registerGlobalLink(input: {
  packageDir: string
}): Promise<string> {
  const { loadManifest } = await import('./manifest')
  const manifest = await loadManifest({ dir: input.packageDir })
  const fullName = manifest.host
    ? `@${manifest.host}/${manifest.name}`
    : manifest.name

  const target = globalLinkPath(fullName)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.rm(target, { force: true })
  await fsp.symlink(path.resolve(input.packageDir), target)

  return fullName
}

// remove a package from the global link registry.
export async function unregisterGlobalLink(input: {
  name: string
}): Promise<void> {
  await fsp.rm(globalLinkPath(input.name), { force: true })
}

// list the package names currently in the global link registry.
export async function listGlobalLinks(): Promise<string[]> {
  const root = path.join(getStoreRoot(), 'link')
  const names: string[] = []

  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name.startsWith('@')) {
        const scope = path.join(root, entry.name)
        const inner = await fsp.readdir(scope)

        for (const child of inner) {
          names.push(`${entry.name}/${child}`)
        }
      } else {
        names.push(entry.name)
      }
    }
  } catch {
    // registry not created yet
  }

  return names
}

// symlink a globally-registered package into a project's `link/` directory. Returns false if the name is not registered.
export async function consumeGlobalLink(input: {
  root: string
  name: string
}): Promise<boolean> {
  const source = globalLinkPath(input.name)

  try {
    await fsp.access(source)
  } catch {
    return false
  }

  const real = await fsp.realpath(source)
  const linkDir = path.join(input.root, LINK_DIR)
  const parts = input.name.split('/')

  let targetLink: string

  if (parts.length === 2) {
    const scopeDir = path.join(linkDir, parts[0]!)
    await fsp.mkdir(scopeDir, { recursive: true })
    targetLink = path.join(scopeDir, parts[1]!)
  } else {
    await fsp.mkdir(linkDir, { recursive: true })
    targetLink = path.join(linkDir, input.name)
  }

  await fsp.rm(targetLink, { force: true })
  await fsp.symlink(real, targetLink)

  return true
}
