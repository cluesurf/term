// Environment variable runtime for the Web platform. A browser has no process environment, so `localStorage` stands
// in for it: the same key/value semantics, scoped to the origin. Reached only through the public environment API.
const variable = {
  get: (name: string): string => localStorage.getItem(name) ?? '',
  set: (name: string, value: string): void =>
    localStorage.setItem(name, value),
  remove: (name: string): void => localStorage.removeItem(name),
  list: (): Record<string, string> => {
    const all: Record<string, string> = {}

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)

      if (key !== null) {
        all[key] = localStorage.getItem(key) ?? ''
      }
    }

    return all
  },
  check: (name: string): boolean => localStorage.getItem(name) !== null,
}
