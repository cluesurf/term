// Environment variable runtime for the Web platform. A browser has no process environment, so `localStorage` stands
// in for it: the same key/value semantics, scoped to the origin. Reached only through the public environment API.
const envVariable = {
  get: (name: string): string => localStorage.getItem(name) ?? '',
  set: (name: string, value: string): void =>
    localStorage.setItem(name, value),
  remove: (name: string): void => localStorage.removeItem(name),
  // a Term `hash` is a Map on this backend, as on node; a plain object here read as a hash with no entries
  list: (): Map<string, string> => {
    const all = new Map<string, string>()

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)

      if (key !== null) {
        all.set(key, localStorage.getItem(key) ?? '')
      }
    }

    return all
  },
  check: (name: string): boolean => localStorage.getItem(name) !== null,
}
