// Browser OPFS file IO, run for real. The browser target has no host in CI, so we drive the compiled browser `file`
// module (which forwards to the OPFS io shim) against an in-memory Origin Private File System: a minimal stand-in for
// navigator.storage.getDirectory() that implements the same FileSystemDirectoryHandle / FileSystemFileHandle surface
// the shim uses. This exercises the real shim logic (path splitting, write/read/append/copy/move/remove/exists), not
// just that it compiles. Run: npx tsx --no-warnings=ExperimentalWarning test/stdlib/opfs.ts

import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@/code/compile/compile'
import { withNativeEnv, nativePrelude } from '@/code/compile/native'
import type { Source } from '@/code/compile/load'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', '..', 'base.tree')
const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)
  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}
const readRuntime = (path: string): string | undefined => {
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, path.slice(prefix.length))
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
    )
  }
}

// ---- in-memory OPFS ----
class MemoryFile {
  data = ''
}
class MemoryDirectory {
  files = new Map<string, MemoryFile>()
  directories = new Map<string, MemoryDirectory>()
  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryDirectory> {
    if (!this.directories.has(name)) {
      if (!options?.create) throw new Error('NotFoundError')
      this.directories.set(name, new MemoryDirectory())
    }
    return this.directories.get(name)!
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new Error('NotFoundError')
      this.files.set(name, new MemoryFile())
    }
    const file = this.files.get(name)!
    return {
      getFile: async () => ({ text: async () => file.data }),
      createWritable: async () => ({
        write: async (data: string) => {
          file.data = data
        },
        close: async () => {},
      }),
    }
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.directories.delete(name))
      throw new Error('NotFoundError')
  }
}

async function loadBrowserFile(): Promise<
  Record<string, (...a: Array<unknown>) => Promise<unknown>>
> {
  const source = `load @cluesurf/base/code/file
  find file

task put
  mark async
  take path, like text
  take data, like text
  call write
    read path
    read data
    wait true

task get
  mark async
  take path, like text
  like text
  send back
    call read
      read path
      wait true

task add
  mark async
  take path, like text
  take data, like text
  call append
    read path
    read data
    wait true

task here
  mark async
  take path, like text
  like boolean
  send back
    call test
      read path
      wait true

task drop
  mark async
  take path, like text
  call remove
    read path
    wait true

task duplicate
  mark async
  take from, like text
  take to, like text
  call copy
    read from
    read to
    wait true

task relocate
  mark async
  take from, like text
  take to, like text
  call move
    read from
    read to
    wait true
`
  const result = compile(
    { file: 'main.tree', text: source },
    { resolve: withNativeEnv('browser', stdlib) },
  )
  if (!result.ok) throw new Error('compile failed')
  const prelude = nativePrelude(result.program, 'browser', readRuntime)
  const js = transformSync(`${prelude}\n${result.typescript}`, {
    loader: 'ts',
    format: 'esm',
  }).code
  const dir = mkdtempSync(join(tmpdir(), 'seed-opfs-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, js)
  return (await import(pathToFileURL(file).href)) as Record<
    string,
    (...a: Array<unknown>) => Promise<unknown>
  >
}

async function main(): Promise<void> {
  const root = new MemoryDirectory()
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory: async () => root } },
    configurable: true,
    writable: true,
  })

  const fs = await loadBrowserFile()

  await fs.put!('note.txt', 'hello opfs')
  expect(
    'opfs: write then read round-trips',
    await fs.get!('note.txt'),
    'hello opfs',
  )
  expect(
    'opfs: exists is true for a written file',
    await fs.here!('note.txt'),
    true,
  )
  expect(
    'opfs: exists is false for a missing file',
    await fs.here!('ghost.txt'),
    false,
  )

  await fs.add!('note.txt', ' and more')
  expect(
    'opfs: append concatenates',
    await fs.get!('note.txt'),
    'hello opfs and more',
  )

  await fs.duplicate!('note.txt', 'copy.txt')
  expect(
    'opfs: copy duplicates the contents',
    await fs.get!('copy.txt'),
    'hello opfs and more',
  )
  expect(
    'opfs: copy leaves the original',
    await fs.here!('note.txt'),
    true,
  )

  await fs.relocate!('copy.txt', 'moved.txt')
  expect(
    'opfs: move writes the destination',
    await fs.get!('moved.txt'),
    'hello opfs and more',
  )
  expect(
    'opfs: move removes the source',
    await fs.here!('copy.txt'),
    false,
  )

  await fs.drop!('note.txt')
  expect(
    'opfs: remove deletes the file',
    await fs.here!('note.txt'),
    false,
  )

  // nested directories: the path splits into directory handles plus a final name
  await fs.put!('deep/nested/file.txt', 'buried')
  expect(
    'opfs: write + read through nested directories',
    await fs.get!('deep/nested/file.txt'),
    'buried',
  )

  console.log(
    `\nopfs: ${pass} pass, ${fail} fail  (compiled browser file module over an in-memory OPFS)`,
  )
  if (fail > 0) process.exit(1)
}

main()
