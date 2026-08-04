// Environment variable runtime for node. Reached only through the public environment API.
const variable = {
  get: (name: string): string => process.env[name] ?? '',
  set: (name: string, value: string): void => {
    process.env[name] = value
  },
  remove: (name: string): void => {
    delete process.env[name]
  },
  list: (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  check: (name: string): boolean => process.env[name] !== undefined,
}
