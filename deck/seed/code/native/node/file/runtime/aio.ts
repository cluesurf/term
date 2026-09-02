// Asynchronous filesystem runtime for node, over `fs/promises`, which is libuv's threadpool behind a promise.
//
// This exists so node's `file/asynchronous*` modules are the SAME modules as the other three backends' rather
// than merely similar ones: same task names, same parameters, same defaults, same return types, with the
// platform confined to the shim. Node used to dock `node:fs/promises` inline in each module, so its task names
// drifted (`open` where the others say `handle-open`, one `read` with a `format` parameter where the others have
// `read` and `read-bytes`) and the public API could not name one set of imports that resolved everywhere.
//
// TOTAL, like the rest of the native surface: a failure reads as the empty / false / zero answer, except a handle
// open, where a missing file cannot be papered over.
//
// Reached only through the public file API. See note/term/stdlib/native-async-file-and-server.md.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

// an open file: the node handle plus the cursor. node's FileHandle DOES carry a position for `read()` with no
// offset, but `write` at a position does not move it, so the cursor is kept here for the same reason swift and
// kotlin keep one.
type Handle = { file: fs.FileHandle; at: number }
type Reader = { file: fs.FileHandle; at: number; left: number | undefined }
type Writer = Handle

const aio = {
  // ---- whole file ----

  fileRead: async (at: string): Promise<string> => {
    try {
      return await fs.readFile(at, 'utf8')
    } catch {
      return ''
    }
  },

  fileReadBytes: async (at: string): Promise<Uint8Array> => {
    try {
      return new Uint8Array(await fs.readFile(at))
    } catch {
      return new Uint8Array()
    }
  },

  fileWrite: async (at: string, data: string): Promise<void> => {
    try {
      await fs.writeFile(at, data)
    } catch {
      return
    }
  },

  fileWriteBytes: async (at: string, data: Uint8Array): Promise<void> => {
    try {
      await fs.writeFile(at, data)
    } catch {
      return
    }
  },

  fileAppend: async (at: string, data: string): Promise<void> => {
    try {
      await fs.appendFile(at, data)
    } catch {
      return
    }
  },

  fileCopy: async (from: string, to: string, deep: boolean): Promise<void> => {
    try {
      if (deep) {
        await fs.cp(from, to, { recursive: true })
      } else {
        await fs.copyFile(from, to)
      }
    } catch {
      return
    }
  },

  fileMove: async (from: string, to: string): Promise<void> => {
    try {
      await fs.rename(from, to)
    } catch {
      return
    }
  },

  fileRemove: async (at: string, deep: boolean): Promise<void> => {
    try {
      await fs.rm(at, { recursive: deep, force: true })
    } catch {
      return
    }
  },

  // an empty `kind` asks only whether the path exists; 'file', 'directory' and 'link' ask what it is
  fileTest: async (at: string, kind: string): Promise<boolean> => {
    try {
      if (kind === 'link') {
        return (await fs.lstat(at)).isSymbolicLink()
      }

      const stats = await fs.stat(at)

      switch (kind) {
        case '':
          return true
        case 'file':
          return stats.isFile()
        case 'directory':
          return stats.isDirectory()
        default:
          return true
      }
    } catch {
      return false
    }
  },

  // ---- link ----

  linkMake: async (from: string, to: string, hard: boolean): Promise<void> => {
    try {
      if (hard) {
        await fs.link(from, to)
      } else {
        await fs.symlink(from, to)
      }
    } catch {
      return
    }
  },

  linkRead: async (at: string): Promise<string> => {
    try {
      return await fs.readlink(at)
    } catch {
      return ''
    }
  },

  // ---- permission and owner ----

  permissionRead: async (at: string): Promise<number> => {
    try {
      return (await fs.stat(at)).mode
    } catch {
      return 0
    }
  },

  permissionWrite: async (at: string, mode: number): Promise<void> => {
    try {
      await fs.chmod(at, mode)
    } catch {
      return
    }
  },

  ownerUser: async (at: string): Promise<number> => {
    try {
      return (await fs.stat(at)).uid
    } catch {
      return 0
    }
  },

  ownerGroup: async (at: string): Promise<number> => {
    try {
      return (await fs.stat(at)).gid
    } catch {
      return 0
    }
  },

  ownerWrite: async (
    at: string,
    user: number,
    group: number,
  ): Promise<void> => {
    try {
      await fs.chown(at, user, group)
    } catch {
      return
    }
  },

  // ---- temporary ----

  // a unique name under the system temporary directory. The name is a uuid, so no retry loop and no mkdtemp
  // template: a collision cannot happen.
  temporaryMake: async (
    kind: string,
    prefix: string,
    suffix: string,
  ): Promise<string> => {
    const at = path.join(os.tmpdir(), `${prefix}${randomUUID()}${suffix}`)

    try {
      if (kind === 'directory') {
        await fs.mkdir(at, { recursive: true })
      } else {
        await fs.writeFile(at, '')
      }
    } catch {
      return ''
    }

    return at
  },

  // ---- handle ----

  handleOpen: async (
    at: string,
    read: boolean,
    write: boolean,
    create: boolean,
    append: boolean,
    clear: boolean,
  ): Promise<Handle> => {
    // the five independent booleans, folded into the one mode string node wants. This is the ONLY place in the
    // asynchronous surface a node mode string appears: it is a node spelling, not part of the API.
    let flags = 'r'

    if (append) {
      flags = read ? 'a+' : 'a'
    } else if (write) {
      flags = read ? (create ? 'w+' : 'r+') : 'w'
    } else if (clear) {
      flags = read ? 'w+' : 'w'
    }

    const file = await fs.open(at, flags)

    return { file, at: append ? (await file.stat()).size : 0 }
  },

  handleClose: async (held: Handle): Promise<void> => {
    try {
      await held.file.close()
    } catch {
      return
    }
  },

  handleRead: async (held: Handle, size: number): Promise<string> => {
    if (size <= 0) {
      return ''
    }

    try {
      const buffer = Buffer.alloc(size)
      const got = await held.file.read(buffer, 0, size, held.at)
      held.at += got.bytesRead

      return buffer.subarray(0, got.bytesRead).toString('utf8')
    } catch {
      return ''
    }
  },

  handleWrite: async (held: Handle, data: string): Promise<number> => {
    try {
      const put = await held.file.write(data, held.at, 'utf8')
      held.at += put.bytesWritten

      return put.bytesWritten
    } catch {
      return 0
    }
  },

  // `frame` is 'start' (absolute), 'relative' (from the cursor) or 'end' (back from the end)
  handleSeek: async (
    held: Handle,
    offset: number,
    frame: string,
  ): Promise<void> => {
    try {
      if (frame === 'relative') {
        held.at += offset
      } else if (frame === 'end') {
        held.at = (await held.file.stat()).size - offset
      } else {
        held.at = Math.max(0, offset)
      }
    } catch {
      return
    }
  },

  handleFlush: async (held: Handle): Promise<void> => {
    try {
      await held.file.datasync()
    } catch {
      return
    }
  },

  handleClear: async (held: Handle, size: number): Promise<void> => {
    try {
      await held.file.truncate(Math.max(0, size))
      held.at = Math.min(held.at, Math.max(0, size))
    } catch {
      return
    }
  },

  // ---- streams ----

  readerOpen: async (
    at: string,
    start: number,
    size: number,
  ): Promise<Reader> => ({
    file: await fs.open(at, 'r'),
    at: Math.max(0, start),
    left: size > 0 ? size : undefined,
  }),

  // the next chunk, or '' at the end of the stream (or of the window)
  readerNext: async (stream: Reader): Promise<string> => {
    if (stream.left !== undefined && stream.left <= 0) {
      return ''
    }

    const want =
      stream.left === undefined ? 65536 : Math.min(stream.left, 65536)

    try {
      const buffer = Buffer.alloc(want)
      const got = await stream.file.read(buffer, 0, want, stream.at)
      stream.at += got.bytesRead

      if (stream.left !== undefined) {
        stream.left -= got.bytesRead
      }

      return buffer.subarray(0, got.bytesRead).toString('utf8')
    } catch {
      return ''
    }
  },

  readerClose: async (stream: Reader): Promise<void> => {
    try {
      await stream.file.close()
    } catch {
      return
    }
  },

  writerOpen: async (at: string, append: boolean): Promise<Writer> => {
    const file = await fs.open(at, append ? 'a' : 'w')

    return { file, at: append ? (await file.stat()).size : 0 }
  },

  writerPush: async (stream: Writer, data: string): Promise<void> => {
    try {
      const put = await stream.file.write(data, stream.at, 'utf8')
      stream.at += put.bytesWritten
    } catch {
      return
    }
  },

  writerClose: async (stream: Writer): Promise<void> => {
    try {
      await stream.file.close()
    } catch {
      return
    }
  },
}
