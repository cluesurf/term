import fsp from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { DeckManifest, FetchConfig } from './form'
import { loadManifest } from './manifest'
import { hashFile } from './hash'
import { showMark } from './mark'
import { fetchPackageMeta } from './fetch'

const execFileAsync = promisify(execFile)

const DEFAULT_INCLUDE = ['code', 'deck.tree', 'note.tree', 'book']
const DEFAULT_EXCLUDE = [
  'link',
  'make',
  'hold',
  'test',
  'task',
  '.seed',
  'node_modules',
  '.git',
  'host',
]

const MAX_FILE_SIZE = 16 * 1024 * 1024
const WARN_PACKAGE_SIZE = 10 * 1024 * 1024
const MAX_PACKAGE_SIZE = 50 * 1024 * 1024

export async function collectFiles(input: {
  dir: string
}): Promise<string[]> {
  const files: string[] = []

  // read .treeignore if exists
  const extraExclude: string[] = []

  try {
    const ignoreText = await fsp.readFile(
      path.join(input.dir, '.treeignore'),
      'utf-8',
    )

    for (const line of ignoreText.split('\n')) {
      const trimmed = line.trim()

      if (trimmed && !trimmed.startsWith('#')) {
        extraExclude.push(trimmed)
      }
    }
  } catch {
    // no .treeignore
  }

  const allExclude = [...DEFAULT_EXCLUDE, ...extraExclude]

  await walkDir({
    base: input.dir,
    dir: input.dir,
    files,
    exclude: allExclude,
  })

  return files
}

async function walkDir(input: {
  base: string
  dir: string
  files: string[]
  exclude: string[]
}): Promise<void> {
  const entries = await fsp.readdir(input.dir, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    const fullPath = path.join(input.dir, entry.name)
    const relative = path.relative(input.base, fullPath)

    if (input.exclude.some(ex => relative.startsWith(ex))) {continue}

    if (entry.name.startsWith('.')) {continue}

    if (entry.isDirectory()) {
      await walkDir({
        base: input.base,
        dir: fullPath,
        files: input.files,
        exclude: input.exclude,
      })
    } else if (entry.isFile()) {
      const stat = await fsp.stat(fullPath)

      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(
          `File too large (${stat.size} bytes): ${relative}`,
        )
      }

      input.files.push(relative)
    }
  }
}

export async function createTarball(input: {
  dir: string
  files: string[]
}): Promise<Buffer> {
  const manifest = await loadManifest({ dir: input.dir })
  const markStr = showMark(manifest.mark)
  const tarName = `${manifest.name}-${markStr}.tgz`
  const tmpDir = path.join(input.dir, '.seed', 'tmp')
  const packageDir = path.join(tmpDir, 'package')
  const tarPath = path.join(tmpDir, tarName)

  await fsp.mkdir(packageDir, { recursive: true })

  // copy files to package/ directory
  for (const file of input.files) {
    const src = path.join(input.dir, file)
    const dst = path.join(packageDir, file)
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    await fsp.copyFile(src, dst)
  }

  // create tarball
  await execFileAsync('tar', ['czf', tarPath, '-C', tmpDir, 'package'])

  const tarball = await fsp.readFile(tarPath)

  // cleanup
  await fsp.rm(tmpDir, { recursive: true, force: true })

  if (tarball.length > MAX_PACKAGE_SIZE) {
    throw new Error(
      `Package too large: ${tarball.length} bytes (max ${MAX_PACKAGE_SIZE})`,
    )
  }

  if (tarball.length > WARN_PACKAGE_SIZE) {
    console.warn(
      `Warning: package is ${tarball.length} bytes (above ${WARN_PACKAGE_SIZE} warning threshold)`,
    )
  }

  return tarball
}

export async function validateManifest(input: {
  manifest: DeckManifest
}): Promise<string[]> {
  const errors: string[] = []

  if (!input.manifest.name) {
    errors.push('Missing package name')
  }

  if (
    input.manifest.mark.major === 0 &&
    input.manifest.mark.minor === 0 &&
    input.manifest.mark.patch === 0
  ) {
    errors.push('Version must be set (not 0.0.0)')
  }

  if (input.manifest.mark.patch % 2 !== 0) {
    errors.push('Published versions must use even patch numbers')
  }

  return errors
}

export async function publishDeck(input: {
  dir: string
  config: FetchConfig
  dryRun: boolean
}): Promise<void> {
  const manifest = await loadManifest({ dir: input.dir })
  const markStr = showMark(manifest.mark)
  const fullName = manifest.host
    ? `@${manifest.host}/${manifest.name}`
    : manifest.name

  // validate
  const errors = await validateManifest({ manifest })

  if (errors.length > 0) {
    throw new Error(
      `Validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`,
    )
  }

  // check if version already exists
  try {
    const meta = await fetchPackageMeta({
      name: fullName,
      config: input.config,
    })

    if (meta.versions[markStr]) {
      throw new Error(
        `Version ${markStr} already published for ${fullName}`,
      )
    }
  } catch (err: any) {
    // 404 means package doesn't exist yet, which is fine
    if (!err.message?.includes('404')) {
      throw err
    }
  }

  // collect files
  const files = await collectFiles({ dir: input.dir })
  console.log(`Files to publish (${files.length}):`)

  for (const file of files) {
    console.log(`  ${file}`)
  }

  // create tarball
  const tarball = await createTarball({ dir: input.dir, files })
  console.log(`Package size: ${tarball.length} bytes`)

  if (input.dryRun) {
    console.log('Dry run complete. No upload.')

    return
  }

  // upload to registry
  const url = `${input.config.registry}/${fullName}/-/${manifest.name}-${markStr}.tgz`

  // read auth token
  const authToken = await loadAuthToken()

  if (!authToken) {
    throw new Error(
      'Not authenticated. Run `seed dock mind` to log in.',
    )
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/gzip',
    },
    body: new Uint8Array(tarball),
  })

  if (!response.ok) {
    throw new Error(
      `Publish failed: ${response.status} ${response.statusText}`,
    )
  }

  console.log(`Published ${fullName}@${markStr}`)
}

async function loadAuthToken(): Promise<string | undefined> {
  const os = await import('os')
  const authFile = path.join(os.homedir(), '.seed', 'auth')

  try {
    const text = await fsp.readFile(authFile, 'utf-8')

    return text.trim()
  } catch {
    return undefined
  }
}
