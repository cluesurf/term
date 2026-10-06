// Environment variable runtime for node. Reached only through the public environment API.
const envVariable = {
  get: (name: string): string => process.env[name] ?? '',
  set: (name: string, value: string): void => {
    process.env[name] = value
  },
  remove: (name: string): void => {
    delete process.env[name]
  },
  // a Map, as `gather-variables` promises (`like hash`) and the browser's shim answers: a plain object here made every
  // `/get` or `/has` on the answer throw on node, and the emitted TypeScript did not typecheck
  list: (): Map<string, string> =>
    new Map(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  check: (name: string): boolean => process.env[name] !== undefined,
}
