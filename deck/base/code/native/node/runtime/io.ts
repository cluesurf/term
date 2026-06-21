// Filesystem metadata and directory operations over node:fs, presented as one namespace so the native module docks it
// as a <global:io> and forwards uniformly, matching the rust, swift, and kotlin io shims. Every call absorbs the host
// error and returns a safe default, so the public file API stays total. The plain file read and write path stays on
// node:fs/promises in native/node/file.tree. This shim covers the synchronous metadata and directory surface.
import { statSync, mkdirSync, rmSync, readdirSync } from 'node:fs'

const io = {
  fileSize: (path: string): number => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  },
  isDirectory: (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  isFile: (path: string): boolean => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  dirMake: (path: string): void => {
    try {
      mkdirSync(path, { recursive: true })
    } catch {
      // best effort
    }
  },
  dirRemove: (path: string): void => {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best effort
    }
  },
  dirList: (path: string): Array<string> => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  dirWalk: (path: string): Array<string> => {
    try {
      return (readdirSync(path, { recursive: true }) as Array<string>).map(
        entry => `${path}/${entry}`,
      )
    } catch {
      return []
    }
  },
}
