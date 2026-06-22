// Browser file IO over the Origin Private File System (OPFS), reached through navigator.storage.getDirectory(). A
// path is split on "/" into nested directory handles plus a final file name. Every operation is asynchronous, since
// OPFS exposes no synchronous API on the main thread. This mirrors the node / rust / swift / kotlin `io` shim members
// so the per-platform file bindings forward to the same names.
const io = (() => {
  const root = (): Promise<FileSystemDirectoryHandle> =>
    navigator.storage.getDirectory()
  const locate = async (
    path: string,
    create: boolean,
  ): Promise<{
    directory: FileSystemDirectoryHandle
    name: string
  }> => {
    const parts = path.split('/').filter(Boolean)
    const name = parts.pop() as string
    let directory = await root()
    for (const part of parts)
      directory = await directory.getDirectoryHandle(part, { create })
    return { directory, name }
  }
  const exists = async (path: string): Promise<boolean> => {
    try {
      const { directory, name } = await locate(path, false)
      await directory.getFileHandle(name)
      return true
    } catch {
      return false
    }
  }
  const read = async (path: string): Promise<string> => {
    const { directory, name } = await locate(path, false)
    const handle = await directory.getFileHandle(name)
    return (await handle.getFile()).text()
  }
  const write = async (path: string, data: string): Promise<void> => {
    const { directory, name } = await locate(path, true)
    const handle = await directory.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(data)
    await writable.close()
  }
  const readBytes = async (path: string): Promise<Uint8Array> => {
    const { directory, name } = await locate(path, false)
    const handle = await directory.getFileHandle(name)
    return new Uint8Array(await (await handle.getFile()).arrayBuffer())
  }
  const writeBytes = async (
    path: string,
    data: Uint8Array,
  ): Promise<void> => {
    const { directory, name } = await locate(path, true)
    const handle = await directory.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(data)
    await writable.close()
  }
  return {
    fileRead: read,
    fileWrite: write,
    fileReadBytes: readBytes,
    fileWriteBytes: writeBytes,
    fileAppend: async (path: string, data: string): Promise<void> => {
      const current = (await exists(path)) ? await read(path) : ''
      await write(path, current + data)
    },
    fileRemove: async (path: string): Promise<void> => {
      const { directory, name } = await locate(path, false)
      await directory.removeEntry(name)
    },
    fileCopy: async (from: string, to: string): Promise<void> =>
      write(to, await read(from)),
    fileMove: async (from: string, to: string): Promise<void> => {
      await write(to, await read(from))
      const { directory, name } = await locate(from, false)
      await directory.removeEntry(name)
    },
    fileExists: exists,
  }
})()
