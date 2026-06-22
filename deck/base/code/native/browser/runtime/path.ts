// Path manipulation, pure POSIX. The browser has no node:path, so this is a small self-contained implementation over
// forward-slash paths. The file extension carries its leading dot. Presented as a <global:path> namespace.
const path = {
  join: (base: string, name: string): string =>
    base.endsWith('/') ? `${base}${name}` : `${base}/${name}`,
  directory: (target: string): string => {
    const cut = target.lastIndexOf('/')
    return cut < 0 ? '' : cut === 0 ? '/' : target.slice(0, cut)
  },
  fileName: (target: string): string =>
    target.slice(target.lastIndexOf('/') + 1),
  fileExtension: (target: string): string => {
    const base = target.slice(target.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    return dot > 0 ? base.slice(dot) : ''
  },
  isAbsolute: (target: string): boolean => target.startsWith('/'),
}
