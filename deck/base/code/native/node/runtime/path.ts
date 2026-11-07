// Path manipulation over node:path, presented as one namespace so the native module docks it as a <global:path> and
// forwards uniformly, matching the rust, swift, and kotlin path shims. The file extension carries its leading dot.
import {
  join as joinPaths,
  dirname,
  basename,
  extname,
  isAbsolute,
} from 'node:path'

const path = {
  join: (base: string, name: string): string => joinPaths(base, name),
  directory: (target: string): string => dirname(target),
  fileName: (target: string): string => basename(target),
  fileExtension: (target: string): string => extname(target),
  isAbsolute: (target: string): boolean => isAbsolute(target),
}
