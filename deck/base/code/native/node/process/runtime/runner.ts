// Subprocess runner over node:child_process. Spawns the command, accumulates stdout and stderr, and resolves with the
// exit code and captured streams when the process closes. A spawn failure resolves with code -1 and the error text, so
// the public run API stays total. A child a signal ended answers code 128 plus the signal's number and `signal` that
// number; one that exited by itself answers its code and signal 0. `directory` (empty is this process's own) and
// `environment` (entries added over the inherited one) shape the child. `limit` (milliseconds, 0 or below none) ends
// the child at the limit with TERM, then KILL 2000 ms later, and resolves with code -2 and what it wrote once it has
// exited and both pipes closed, or 500 ms after the exit (a grandchild may hold a pipe). Reached only through the
// public run API.
import { spawn } from 'node:child_process'
import { constants as runnerConstants } from 'node:os'

type RunnerResult = {
  code: number
  output: string
  error: string
  signal: number
}
type RunnerChild = ReturnType<typeof spawn>

// the number of a signal's name, 0 when node has none for it
const signalNumber = (name: string | null): number =>
  name === null
    ? 0
    : ((runnerConstants.signals as Record<string, number>)[name] ?? 0)

// the exit code a close answers: the child's own, or 128 plus its signal
const closeCode = (
  code: number | null,
  name: string | null,
): number => {
  const signal = signalNumber(name)

  return signal > 0 ? 128 + signal : (code ?? 0)
}

const runnerOptions = (
  directory: string,
  environment: Map<string, string> | undefined,
) => ({
  cwd: directory === '' ? undefined : directory,
  env: {
    ...process.env,
    ...Object.fromEntries(environment ?? new Map()),
  },
})

// the limit's timers on a running child: TERM at the limit, KILL 2000 ms after. `ended` says whether the limit fired,
// and `clear` stops whichever timers are still waiting
const runnerLimit = (
  child: RunnerChild,
  limit: number,
): { ended: () => boolean; clear: () => void } => {
  let fired = false
  let term: ReturnType<typeof setTimeout> | undefined
  let kill: ReturnType<typeof setTimeout> | undefined

  if (limit > 0) {
    term = setTimeout(() => {
      fired = true
      child.kill('SIGTERM')
      kill = setTimeout(() => {
        child.kill('SIGKILL')
      }, 2000)
    }, limit)
  }

  return {
    ended: () => fired,
    clear: () => {
      if (term !== undefined) {
        clearTimeout(term)
      }
      if (kill !== undefined) {
        clearTimeout(kill)
      }
    },
  }
}

// a captured child's answer, at its close, or under a limit 500 ms after its exit if the pipes are still open; code -2
// for a run its limit ended
const runnerCapture = (
  child: RunnerChild,
  limit: number,
  resolve: (result: RunnerResult) => void,
): void => {
  let output = ''
  let error = ''
  let done = false
  let drain: ReturnType<typeof setTimeout> | undefined
  const timer = runnerLimit(child, limit)
  const finish = (result: RunnerResult) => {
    if (done) {
      return
    }
    done = true
    timer.clear()
    if (drain !== undefined) {
      clearTimeout(drain)
    }
    resolve(result)
  }

  // each stream decodes through one UTF-8 decoder, which carries a character a pipe chunk splits over to the next
  // chunk, so a multi-byte character across a 65,536-byte boundary reads whole (decision 081)
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    error += chunk
  })
  child.on('error', (cause: Error) => {
    finish({
      code: -1,
      output,
      error: error + String(cause),
      signal: 0,
    })
  })
  // under a limit a grandchild holding a pipe cannot hold the answer: 500 ms after the exit it is taken as it stands
  child.on('exit', (code: number | null, name: string | null) => {
    timer.clear()
    if (limit > 0) {
      drain = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(
          timer.ended()
            ? { code: -2, output, error, signal: 0 }
            : {
                code: closeCode(code, name),
                output,
                error,
                signal: signalNumber(name),
              },
        )
      }, 500)
    }
  })
  child.on('close', (code: number | null, name: string | null) => {
    if (timer.ended()) {
      finish({ code: -2, output, error, signal: 0 })
    } else {
      finish({
        code: closeCode(code, name),
        output,
        error,
        signal: signalNumber(name),
      })
    }
  })
}

const runner = {
  run: (
    command: string,
    argumentList: string[],
    directory: string,
    environment: Map<string, string> | undefined,
    limit: number,
  ): Promise<RunnerResult> =>
    new Promise(resolve => {
      try {
        runnerCapture(
          spawn(
            command,
            argumentList,
            runnerOptions(directory, environment),
          ),
          limit,
          resolve,
        )
      } catch (cause) {
        resolve({
          code: -1,
          output: '',
          error: String(cause),
          signal: 0,
        })
      }
    }),
  // the command on this terminal: it reads the keyboard and writes as it goes (a password prompt, a progress bar),
  // and the answer is its exit code (128 plus the signal for a signal death), -1 when it could not start, -2 when its
  // limit ended it. While it runs this process does what system(3) does: it ignores INT and QUIT (the terminal's
  // ctrl-c and ctrl-backslash reach the child through the foreground group, so it gets each once) and passes TERM and
  // HUP, sent to this process alone, on to the child. The handlers go in after the spawn, so the child keeps the
  // default dispositions, and come out when the child ends
  attached: (
    command: string,
    argumentList: string[],
    directory: string,
    environment: Map<string, string> | undefined,
    limit: number,
  ): Promise<number> =>
    new Promise(resolve => {
      try {
        const child = spawn(command, argumentList, {
          ...runnerOptions(directory, environment),
          stdio: 'inherit',
        })
        const timer = runnerLimit(child, limit)
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
          timer.clear()
          for (const [name, handler] of handlers) {
            process.off(name, handler)
          }
        }
        child.on('error', () => {
          release()
          resolve(-1)
        })
        child.on(
          'close',
          (code: number | null, name: string | null) => {
            release()
            resolve(timer.ended() ? -2 : closeCode(code, name))
          },
        )
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
    limit: number,
  ): Promise<RunnerResult> =>
    new Promise(resolve => {
      try {
        const child = spawn(
          command,
          argumentList,
          runnerOptions(directory, environment),
        )
        runnerCapture(child, limit, resolve)
        child.stdin.on('error', () => {})
        child.stdin.end(input)
      } catch (cause) {
        resolve({
          code: -1,
          output: '',
          error: String(cause),
          signal: 0,
        })
      }
    }),
}
