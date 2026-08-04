// Child process runtime for node. The event-plus-promise plumbing lives here rather than in the seed source, because
// constructing a promise around an event emitter needs inline callbacks that the language does not have. Reached only
// through the public process API.
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'

const child = {
  // resolve with the process's exit code once it exits
  wait: (proc: ChildProcess): Promise<number> =>
    new Promise(resolve => {
      proc.on('exit', code => resolve(code ?? 0))
    }),

  stop: (proc: ChildProcess): void => {
    proc.kill('SIGTERM')
  },

  kill: (proc: ChildProcess): void => {
    proc.kill('SIGKILL')
  },

  write: (proc: ChildProcess, data: string): void => {
    proc.stdin?.write(data)
  },

  close: (proc: ChildProcess): void => {
    proc.stdin?.end()
  },

  // collect a stream to completion; `kind` selects stdout or stderr
  read: (proc: ChildProcess, kind: string): Promise<string> => {
    const stream: Readable | null =
      kind === 'stderr' ? proc.stderr : proc.stdout

    if (!stream) {
      return Promise.resolve('')
    }

    return new Promise(resolve => {
      const chunks: Buffer[] = []

      stream.on('data', chunk => chunks.push(chunk as Buffer))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()))
    })
  },
}
