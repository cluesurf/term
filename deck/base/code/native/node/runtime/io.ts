// Filesystem metadata and directory operations over node:fs, presented as one namespace so the native module docks it
// as a <global:io> and forwards uniformly, matching the rust, swift, and kotlin io shims. Every call absorbs the host
// error and returns a safe default, so the public file API stays total. The plain file read and write path stays on
// node:fs/promises in native/node/file.tree. This shim covers the synchronous metadata and directory surface.
import {
  statSync as ioStatSync,
  mkdirSync as ioMkdirSync,
  rmSync as ioRmSync,
  readdirSync as ioReaddirSync,
} from 'node:fs'

const io = {
  fileSize: (path: string): number => {
    try {
      return ioStatSync(path).size
    } catch {
      return 0
    }
  },
  isDirectory: (path: string): boolean => {
    try {
      return ioStatSync(path).isDirectory()
    } catch {
      return false
    }
  },
  isFile: (path: string): boolean => {
    try {
      return ioStatSync(path).isFile()
    } catch {
      return false
    }
  },
  dirMake: (path: string): void => {
    try {
      ioMkdirSync(path, { recursive: true })
    } catch {
      // best effort
    }
  },
  dirRemove: (path: string): void => {
    try {
      ioRmSync(path, { recursive: true, force: true })
    } catch {
      // best effort
    }
  },
  dirList: (path: string): Array<string> => {
    try {
      return ioReaddirSync(path)
    } catch {
      return []
    }
  },
  dirWalk: (path: string): Array<string> => {
    try {
      return (
        ioReaddirSync(path, { recursive: true }) as Array<string>
      ).map(entry => `${path}/${entry}`)
    } catch {
      return []
    }
  },
}
