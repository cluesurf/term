// Web Storage runtime. The store is chosen by name here rather than in the seed source, and `Storage` is index-based
// rather than iterable so listing its keys needs a loop. Reached only through the public storage API.
const storage = {
  // `store` is "session" or anything else, which means local
  pick: (store: string): Storage =>
    store === 'session' ? sessionStorage : localStorage,

  get: (key: string, store: string): string =>
    storage.pick(store).getItem(key) ?? '',

  set: (key: string, value: string, store: string): void =>
    storage.pick(store).setItem(key, value),

  remove: (key: string, store: string): void =>
    storage.pick(store).removeItem(key),

  clear: (store: string): void => storage.pick(store).clear(),

  length: (store: string): number => storage.pick(store).length,

  keys: (store: string): string[] => {
    const from = storage.pick(store)
    const keys: string[] = []

    for (let i = 0; i < from.length; i++) {
      const key = from.key(i)

      if (key !== null) {
        keys.push(key)
      }
    }

    return keys
  },
}
