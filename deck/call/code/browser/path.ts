// `path` for the browser compile: posix only, over the absolute paths of the in-memory snapshot (./disk.ts). The
// bundle aliases `path` and `node:path` here. Only what the compile path calls is spelled out, and each one behaves
// as Node's posix `path` does for an absolute input.

export const sep = '/'

export const delimiter = ':'

function split(path: string): string[] {
  return path.split('/').filter(part => part !== '' && part !== '.')
}

export function normalize(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []

  for (const part of split(path)) {
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop()
      } else if (!absolute) {
        parts.push('..')
      }

      continue
    }

    parts.push(part)
  }

  const body = parts.join('/')

  return absolute ? `/${body}` : body || '.'
}

export function join(...paths: string[]): string {
  const joined = paths.filter(path => path !== '').join('/')

  return joined === '' ? '.' : normalize(joined)
}

// the working directory of a worker is the root of the snapshot's filesystem
export function resolve(...paths: string[]): string {
  let out = ''

  for (const path of paths) {
    out = path.startsWith('/') ? path : `${out}/${path}`
  }

  return normalize(out.startsWith('/') ? out : `/${out}`)
}

export function dirname(path: string): string {
  const at = path.replace(/\/+$/, '').lastIndexOf('/')

  if (at < 0) {
    return '.'
  }

  return at === 0 ? '/' : path.slice(0, at)
}

export function basename(path: string, extension?: string): string {
  const base = path.replace(/\/+$/, '').split('/').pop() ?? ''

  return extension && base.endsWith(extension) ? base.slice(0, -extension.length) : base
}

export function extname(path: string): string {
  const base = basename(path)
  const at = base.lastIndexOf('.')

  return at <= 0 ? '' : base.slice(at)
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

export function relative(from: string, to: string): string {
  const a = split(resolve(from))
  const b = split(resolve(to))

  let same = 0

  while (same < a.length && same < b.length && a[same] === b[same]) {
    same += 1
  }

  return [...a.slice(same).map(() => '..'), ...b.slice(same)].join('/')
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
