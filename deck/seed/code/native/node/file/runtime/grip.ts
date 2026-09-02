// Synchronous file handles for node, over fs's *Sync calls. A node file descriptor carries no cursor of its own
// (every readSync / writeSync takes a position), so the cursor lives here, the same way it does on the swift and
// kotlin targets.
//
// Reached only through the public file/synchronous API.
import * as fs from 'node:fs'

type Grip = { fd: number; at: number }

const grip = {
  gripOpen: (
    path: string,
    read: boolean,
    write: boolean,
    create: boolean,
    append: boolean,
    clear: boolean,
  ): Grip => {
    // the five independent booleans, folded into the one mode string node wants. This is the ONLY place a node
    // mode string appears: it is a node spelling, not part of the API.
    let flags = 'r'

    if (append) {
      flags = read ? 'a+' : 'a'
    } else if (write) {
      flags = read ? (create ? 'w+' : 'r+') : 'w'
    }

    if (clear && !append && !write) {
      flags = read ? 'w+' : 'w'
    }

    const fd = fs.openSync(path, flags)

    return { fd, at: append ? fs.fstatSync(fd).size : 0 }
  },

  gripClose: (file: Grip): void => {
    try {
      fs.closeSync(file.fd)
    } catch {
      return
    }
  },

  gripRead: (file: Grip, size: number): string => {
    if (size <= 0) {
      return ''
    }

    const buffer = Buffer.alloc(size)

    try {
      const count = fs.readSync(file.fd, buffer, 0, size, file.at)
      file.at += count

      return buffer.subarray(0, count).toString('utf8')
    } catch {
      return ''
    }
  },

  gripWrite: (file: Grip, data: string): number => {
    try {
      const count = fs.writeSync(file.fd, data, file.at, 'utf8')
      file.at += count

      return count
    } catch {
      return 0
    }
  },

  gripSeek: (file: Grip, offset: number, frame: string): void => {
    if (frame === 'relative') {
      file.at += offset
    } else if (frame === 'end') {
      file.at = fs.fstatSync(file.fd).size - offset
    } else {
      file.at = Math.max(0, offset)
    }
  },

  gripFlush: (file: Grip): void => {
    try {
      fs.fdatasyncSync(file.fd)
    } catch {
      return
    }
  },

  gripClear: (file: Grip, size: number): void => {
    try {
      fs.ftruncateSync(file.fd, Math.max(0, size))
      file.at = Math.min(file.at, Math.max(0, size))
    } catch {
      return
    }
  },
}
