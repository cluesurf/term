// Child processes over node:child_process, held by number. `start` spawns the command with all three streams piped and
// answers the child's number once it started or failed to (`refusal` then holds the reason, the empty text when it
// started). Each stream decodes through one UTF-8 decoder and gathers into a buffer that `line` and `rest` take from.
// `limit` (milliseconds, 0 or below none) ends the child at the limit with TERM, then KILL 2000 ms later, and `group`
// makes the child lead a new process group, so the limit and `stop` signal the whole group. `wait` answers once the
// child has exited and both streams ended, or under a limit 500 ms after the exit (a grandchild may hold a pipe): its
// code, 128 plus the signal's number for a signal death, -2 when its limit ended it, -1 when it never started. The same
// rules as the run runner (runner.ts, D025). Reached only through the public process/child API.
import { spawn as childProcessSpawn } from 'node:child_process'
import { constants as childProcessConstants } from 'node:os'

type ChildProcessStream = { text: string; ended: boolean }

type ChildProcessHeld = {
  proc: ReturnType<typeof childProcessSpawn> | undefined
  refusal: string
  out: ChildProcessStream
  err: ChildProcessStream
  group: boolean
  limit: number
  exited: boolean
  code: number
  signal: number
  fired: boolean
  drained: boolean
  timers: ReturnType<typeof setTimeout>[]
  // checks waiting for the next change: each answers true once it is settled
  waiting: (() => boolean)[]
}

const childProcessHeld = new Map<number, ChildProcessHeld>()
let childProcessNext = 0

const childProcessSignalNumber = (name: string | null): number =>
  name === null
    ? 0
    : ((childProcessConstants.signals as Record<string, number>)[name] ??
      0)

// run every waiting check again, keeping those not yet settled
const childProcessMoved = (held: ChildProcessHeld): void => {
  held.waiting = held.waiting.filter(check => !check())
}

// a promise of what `answer` gives once it gives anything other than undefined
const childProcessWhen = <T>(
  held: ChildProcessHeld,
  answer: () => T | undefined,
): Promise<T> =>
  new Promise(resolve => {
    const check = (): boolean => {
      const value = answer()

      if (value === undefined) {
        return false
      }
      resolve(value)
      return true
    }

    if (!check()) {
      held.waiting.push(check)
    }
  })

// whether the child is over: exited with both streams ended, or exited under a limit 500 ms ago
const childProcessOver = (held: ChildProcessHeld): boolean =>
  held.proc === undefined ||
  (held.exited && ((held.out.ended && held.err.ended) || held.drained))

// a signal to the child, or to its whole group when it leads one. One already gone is left alone
const childProcessSignal = (
  held: ChildProcessHeld,
  name: NodeJS.Signals,
): void => {
  const pid = held.proc?.pid

  if (pid === undefined || held.exited) {
    return
  }
  try {
    if (held.group) {
      process.kill(-pid, name)
    } else {
      held.proc?.kill(name)
    }
  } catch {
    // the child or its group is gone already
  }
}

const childProcessTake = (
  held: ChildProcessHeld,
  error: boolean,
): ChildProcessStream => (error ? held.err : held.out)

const childProcess = {
  start: (
    command: string,
    argumentList: string[],
    directory: string,
    environment: Map<string, string> | undefined,
    limit: number,
    group: boolean,
  ): Promise<number> =>
    new Promise(resolve => {
      childProcessNext += 1
      const handle = childProcessNext
      const held: ChildProcessHeld = {
        proc: undefined,
        refusal: '',
        out: { text: '', ended: false },
        err: { text: '', ended: false },
        group,
        limit,
        exited: false,
        code: -1,
        signal: 0,
        fired: false,
        drained: false,
        timers: [],
        waiting: [],
      }

      childProcessHeld.set(handle, held)
      const refuse = (cause: unknown) => {
        held.proc = undefined
        held.refusal = String(cause)
        held.code = -1
        childProcessMoved(held)
        resolve(handle)
      }

      try {
        const proc = childProcessSpawn(command, argumentList, {
          cwd: directory === '' ? undefined : directory,
          env: {
            ...process.env,
            ...Object.fromEntries(environment ?? new Map()),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: group,
        })

        held.proc = proc
        proc.stdout.setEncoding('utf8')
        proc.stderr.setEncoding('utf8')
        proc.stdout.on('data', (chunk: string) => {
          held.out.text += chunk
          childProcessMoved(held)
        })
        proc.stderr.on('data', (chunk: string) => {
          held.err.text += chunk
          childProcessMoved(held)
        })
        proc.stdout.on('close', () => {
          held.out.ended = true
          childProcessMoved(held)
        })
        proc.stderr.on('close', () => {
          held.err.ended = true
          childProcessMoved(held)
        })
        proc.stdin.on('error', () => {})
        proc.on('error', refuse)
        proc.on('spawn', () => {
          if (limit > 0) {
            held.timers.push(
              setTimeout(() => {
                if (held.exited) {
                  return
                }
                held.fired = true
                childProcessSignal(held, 'SIGTERM')
                held.timers.push(
                  setTimeout(() => {
                    childProcessSignal(held, 'SIGKILL')
                  }, 2000),
                )
              }, limit),
            )
          }
          resolve(handle)
        })
        proc.on('exit', (code: number | null, name: string | null) => {
          const signal = childProcessSignalNumber(name)

          held.exited = true
          held.signal = signal
          held.code = signal > 0 ? 128 + signal : (code ?? 0)
          for (const timer of held.timers) {
            clearTimeout(timer)
          }
          held.timers = []
          if (limit > 0) {
            setTimeout(() => {
              held.drained = true
              childProcessMoved(held)
            }, 500)
          }
          childProcessMoved(held)
        })
      } catch (cause) {
        refuse(cause)
      }
    }),

  refusal: (handle: number): string =>
    childProcessHeld.get(handle)?.refusal ?? 'no such child',

  // the next line with its newline, or at the end of the stream what is left (the empty text when nothing is)
  line: (handle: number, error: boolean): Promise<string> => {
    const held = childProcessHeld.get(handle)

    if (held === undefined) {
      return Promise.resolve('')
    }
    return childProcessWhen(held, () => {
      const stream = childProcessTake(held, error)
      const at = stream.text.indexOf('\n')

      if (at >= 0) {
        const line = stream.text.slice(0, at + 1)

        stream.text = stream.text.slice(at + 1)
        return line
      }
      if (stream.ended || childProcessOver(held)) {
        const rest = stream.text

        stream.text = ''
        return rest
      }
      return undefined
    })
  },

  // everything left on the stream once it has ended (or the child is over)
  rest: (handle: number, error: boolean): Promise<string> => {
    const held = childProcessHeld.get(handle)

    if (held === undefined) {
      return Promise.resolve('')
    }
    return childProcessWhen(held, () => {
      const stream = childProcessTake(held, error)

      if (stream.ended || childProcessOver(held)) {
        const rest = stream.text

        stream.text = ''
        return rest
      }
      return undefined
    })
  },

  write: (handle: number, data: string): Promise<void> =>
    new Promise(resolve => {
      const stdin = childProcessHeld.get(handle)?.proc?.stdin

      if (stdin === undefined || stdin === null || stdin.destroyed) {
        resolve()
        return
      }
      stdin.write(data, () => resolve())
    }),

  close: (handle: number): void => {
    childProcessHeld.get(handle)?.proc?.stdin?.end()
  },

  stop: (handle: number, hard: boolean): void => {
    const held = childProcessHeld.get(handle)

    if (held !== undefined) {
      childProcessSignal(held, hard ? 'SIGKILL' : 'SIGTERM')
    }
  },

  wait: (handle: number): Promise<number> => {
    const held = childProcessHeld.get(handle)

    if (held === undefined) {
      return Promise.resolve(-1)
    }
    return childProcessWhen(held, () => {
      if (held.proc === undefined) {
        return -1
      }
      if (!childProcessOver(held)) {
        return undefined
      }
      held.proc.stdout?.destroy()
      held.proc.stderr?.destroy()
      return held.fired ? -2 : held.code
    })
  },

  signal: (handle: number): number => {
    const held = childProcessHeld.get(handle)

    return held === undefined || held.fired ? 0 : held.signal
  },
}
