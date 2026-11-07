// Path manipulation over node:path, presented as one namespace so the native module docks it as a <global:path> and
// forwards uniformly, matching the rust, swift, and kotlin path shims. The file extension carries its leading dot.
import {
  join as joinPaths,
  dirname as pathDirname,
  basename as pathBasename,
  extname as pathExtname,
  isAbsolute as pathIsAbsolute,
} from 'node:path'

const path = {
  join: (base: string, name: string): string => joinPaths(base, name),
  directory: (target: string): string => pathDirname(target),
  fileName: (target: string): string => pathBasename(target),
  fileExtension: (target: string): string => pathExtname(target),
  isAbsolute: (target: string): boolean => pathIsAbsolute(target),
}
