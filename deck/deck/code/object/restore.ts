// Writing a release back to disk.
//
// This replaces the recursive directory walk in `checkout.ts`. A version is a flat set
// of file records (`dataset.ts`), so a checkout reads the dataset, recreates each
// path's parent directories, and streams each file's chunks back in order. The
// directory tree is derived from the paths, the way git's index and tar both do it.

import fsp from 'fs/promises'
import path from 'path'
import { readDataset } from '@term/base/code/store/tree'
import type { ChunkStore } from '@term/base/code/store/chunk-store'

import { filesOfDataset } from './dataset'
import { formatTree } from '@term/base/code/tree/format'
import type { PackageFile } from './dataset'
import type { ObjectStore } from './store'

// A path from a release must never escape the destination. A crafted `..` or an
// absolute path would otherwise write anywhere the process can reach, so every path is
// resolved and checked against the destination before anything is created.
export function safeJoin(dest: string, at: string): string {
  const target = path.resolve(dest, at)
  const root = path.resolve(dest)

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`path escapes the destination: ${at}`)
  }

  return target
}

// Write one file's bytes.
//
// A `.tree` file is REGENERATED from its record by the canonical formatter, since it
// was parsed rather than chunked on publish. Everything else is reassembled from its
// chunks in order.
async function writeFile(input: {
  file: PackageFile
  target: string
  store: ObjectStore
}): Promise<void> {
  if (input.file.record) {
    await fsp.writeFile(input.target, formatTree(input.file.record))

    if (input.file.mode === 'exec') {
      await fsp.chmod(input.target, 0o755)
    }

    return
  }

  const parts: Array<Buffer> = []

  for (const id of input.file.chunks) {
    parts.push(await input.store.get(id))
  }

  await fsp.writeFile(input.target, Buffer.concat(parts))

  if (input.file.mode === 'exec') {
    await fsp.chmod(input.target, 0o755)
  }
}

// Write every file of a version into `dest`.
export async function restoreFiles(input: {
  files: Array<PackageFile>
  dest: string
  store: ObjectStore
}): Promise<void> {
  await fsp.mkdir(input.dest, { recursive: true })

  for (const file of input.files) {
    const target = safeJoin(input.dest, file.path)

    // an empty directory is its own record and has no bytes
    if (file.mode === 'dir') {
      await fsp.mkdir(target, { recursive: true })
      continue
    }

    await fsp.mkdir(path.dirname(target), { recursive: true })
    await writeFile({ file, target, store: input.store })
  }
}

// Write a version out by its prolly-tree root.
export async function restoreVersion(input: {
  root: string
  dest: string
  chunks: ChunkStore
  store: ObjectStore
}): Promise<Array<PackageFile>> {
  const files = filesOfDataset(readDataset(input.root, input.chunks))

  await restoreFiles({ files, dest: input.dest, store: input.store })

  return files
}
