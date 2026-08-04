// Web Storage key enumeration. `Storage` is index-based rather than iterable, so listing its keys needs a loop; that
// is the only part the seed source cannot express directly. Reached only through the public storage API.
const storage = {
  keys: (store: Storage): string[] => {
    const keys: string[] = []

    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)

      if (key !== null) {
        keys.push(key)
      }
    }

    return keys
  },
}
