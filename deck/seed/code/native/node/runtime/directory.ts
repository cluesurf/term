// Working directory runtime for node. Reached only through the public environment API.
const directory = {
  get: (): string => process.cwd(),
  set: (path: string): void => process.chdir(path),
}
