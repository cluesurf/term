// Subprocess runner over node:child_process. Spawns the command, accumulates stdout and stderr, and resolves with the
// exit code and captured streams when the process closes. A spawn failure resolves with code -1 and the error text, so
// the public run API stays total. Reached only through the public run API.
import { spawn } from 'node:child_process'

const runner = {
  run: (
    command: string,
    argumentList: string[],
  ): Promise<{ code: number; output: string; error: string }> =>
    new Promise(resolve => {
      let output = ''
      let error = ''
      try {
        const child = spawn(command, argumentList)
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          error += chunk.toString()
        })
        child.on('error', (cause: Error) => {
          resolve({ code: -1, output, error: error + String(cause) })
        })
        child.on('close', (code: number | null) => {
          resolve({ code: code ?? 0, output, error })
        })
      } catch (cause) {
        resolve({ code: -1, output, error: String(cause) })
      }
    }),
  // the command on this terminal: it reads the keyboard and writes as it goes (a password prompt, a progress bar),
  // and the answer is its exit code, -1 when it could not start
  attached: (command: string, argumentList: string[]): Promise<number> =>
    new Promise(resolve => {
      try {
        const child = spawn(command, argumentList, { stdio: 'inherit' })
        child.on('error', () => resolve(-1))
        child.on('close', (code: number | null) => resolve(code ?? 0))
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
  ): Promise<{ code: number; output: string; error: string }> =>
    new Promise(resolve => {
      let output = ''
      let error = ''
      try {
        const child = spawn(command, argumentList)
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          error += chunk.toString()
        })
        child.on('error', (cause: Error) => {
          resolve({ code: -1, output, error: error + String(cause) })
        })
        child.on('close', (code: number | null) => {
          resolve({ code: code ?? 0, output, error })
        })
        child.stdin.on('error', () => {})
        child.stdin.end(input)
      } catch (cause) {
        resolve({ code: -1, output, error: String(cause) })
      }
    }),
}
