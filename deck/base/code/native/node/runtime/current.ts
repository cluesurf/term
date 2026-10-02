// Current-process runtime for node. Signal names are mapped from the seed spelling, and the handler is registered
// through an event listener, which needs a callback the seed source cannot write inline. Reached only through the
// public process API.
const current = {
  id: (): number => process.pid,

  // the program's own arguments, as on every backend: argv[0] is node and argv[1] the script
  arguments: (): string[] => process.argv.slice(2),

  directory: (): string => process.cwd(),

  executable: (): string => process.execPath,

  exit: (code: number): void => process.exit(code),

  // `signal` is one of "terminate", "interrupt", "hangup"; anything else is ignored
  listen: (signal: string, handler: () => void): void => {
    const names: Record<string, NodeJS.Signals> = {
      terminate: 'SIGTERM',
      interrupt: 'SIGINT',
      hangup: 'SIGHUP',
    }

    const name = names[signal]

    if (name) {
      process.on(name, handler)
    }
  },
}
