// `path` for the browser compile: posix only, over the absolute paths of the in-memory snapshot (./disk.ts). The
// bundle aliases `path` and `node:path` here. Only what the compile path calls is spelled out, and each one behaves
// as Node's posix `path` does for an absolute input.
//
// Every decision is Term since 2026-10-06, browser/posix.tree. This file is what makes it Node's module: `sep`,
// `delimiter`, the default export, and `join` and `resolve` taking any number of paths.

import * as port from '@term/call/code/browser/posix'

export const sep = '/'

export const delimiter = ':'

export function normalize(path: string): string {
  return port.normalize(path)
}

export function join(...paths: string[]): string {
  return port.joinPaths(paths)
}

// the working directory of a worker is the root of the snapshot's filesystem
export function resolve(...paths: string[]): string {
  return port.resolvePaths(paths)
}

export function dirname(path: string): string {
  return port.dirname(path)
}

export function basename(path: string, extension?: string): string {
  return port.basename(path, extension ?? '')
}

export function extname(path: string): string {
  return port.extname(path)
}

export function isAbsolute(path: string): boolean {
  return port.isAbsolute(path)
}

export function relative(from: string, to: string): string {
  return port.relative(from, to)
}

export const posix = {
  sep,
  delimiter,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  isAbsolute,
  relative,
}

export default posix
