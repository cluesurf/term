// Subprocess runner over node:child_process. Spawns the command, accumulates stdout and stderr, and resolves with the
// exit code and captured streams when the process closes. A spawn failure resolves with code -1 and the error text, so
// the public run API stays total. A child a signal ended answers code 128 plus the signal's number and `signal` that
// number; one that exited by itself answers its code and signal 0. `directory` (empty is this process's own) and
// `environment` (entries added over the inherited one) shape the child. Reached only through the public run API.
import { spawn } from 'node:child_process'
import { constants as runnerConstants } from 'node:os'

type RunnerResult = { code: number; output: string; error: string; signal: number }

// the number of a signal's name, 0 when node has none for it
const signalNumber = (name: string | null): number =>
  name === null ? 0 : ((runnerConstants.signals as Record<string, number>)[name] ?? 0)

// the exit code a close answers: the child's own, or 128 plus its signal
const closeCode = (code: number | null, name: string | null): number => {
  const signal = signalNumber(name)

  return signal > 0 ? 128 + signal : (code ?? 0)
}

const runnerOptions = (directory: string, environment: Map<string, string> | undefined) => ({
  cwd: directory === '' ? undefined : directory,
  env: { ...process.env, ...Object.fromEntries(environment ?? new Map()) },
})

const runner = {
  run: (
    command: string,
    argumentList: string[],
    directory: string,
    environment: Map<string, string> | undefined,
  ): Promise<RunnerResult> =>
    new Promise(resolve => {
      let output = ''
      let error = ''
      try {
        const child = spawn(command, argumentList, runnerOptions(directory, environment))
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          error += chunk.toString()
        })
        child.on('error', (cause: Error) => {
          resolve({ code: -1, output, error: error + String(cause), signal: 0 })
        })
        child.on('close', (code: number | null, name: string | null) => {
          resolve({ code: closeCode(code, name), output, error, signal: signalNumber(name) })
        })
      } catch (cause) {
        resolve({ code: -1, output, error: String(cause), signal: 0 })
      }
    }),
  // the command on this terminal: it reads the keyboard and writes as it goes (a password prompt, a progress bar),
  // and the answer is its exit code (128 plus the signal for a signal death), -1 when it could not start. While it
  // runs this process does what system(3) does: it ignores INT and QUIT (the terminal's ctrl-c and ctrl-backslash
  // reach the child through the foreground group, so it gets each once) and passes TERM and HUP, sent to this process
  // alone, on to the child. The handlers go in after the spawn, so the child keeps the default dispositions, and come
  // out when the child ends
  attached: (
    command: string,
    argumentList: string[],
    directory: string,
    environment: Map<string, string> | undefined,
  ): Promise<number> =>
    new Promise(resolve => {
      try {
        const child = spawn(command, argumentList, { ...runnerOptions(directory, environment), stdio: 'inherit' })
        const forward = (name: NodeJS.Signals) => () => {
          child.kill(name)
        }
        const handlers: [NodeJS.Signals, () => void][] = [
          ['SIGINT', () => {}],
          ['SIGQUIT', () => {}],
          ['SIGTERM', forward('SIGTERM')],
          ['SIGHUP', forward('SIGHUP')],
        ]
        for (const [name, handler] of handlers) {
          process.on(name, handler)
        }
        const release = () => {
          for (const [name, handler] of handlers) {
            process.off(name, handler)
          }
        }
        child.on('error', () => {
          release()
          resolve(-1)
        })
        child.on('close', (code: number | null, name: string | null) => {
          release()
          resolve(closeCode(code, name))
        })
      } catch {
        resolve(-1)
      }
    }),
  // the command with `input` written to its standard input and then closed (an installer's prompts answered), its
  // output captured as `run` captures it
  withInput: (
    command: string,
    argumentList: string[],
    input: string,
    directory: string,
    environment: Map<string, string> | undefined,
  ): Promise<RunnerResult> =>
    new Promise(resolve => {
      let output = ''
      let error = ''
      try {
        const child = spawn(command, argumentList, runnerOptions(directory, environment))
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          error += chunk.toString()
        })
        child.on('error', (cause: Error) => {
          resolve({ code: -1, output, error: error + String(cause), signal: 0 })
        })
        child.on('close', (code: number | null, name: string | null) => {
          resolve({ code: closeCode(code, name), output, error, signal: signalNumber(name) })
        })
        child.stdin.on('error', () => {})
        child.stdin.end(input)
      } catch (cause) {
        resolve({ code: -1, output, error: String(cause), signal: 0 })
      }
    }),
}
