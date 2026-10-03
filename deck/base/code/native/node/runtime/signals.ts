// The signals a program that owns the terminal answers, on node (terminal-target-0006), and the read that lets it
// answer them. A resize (SIGWINCH) repaints at once rather than on the next key, and SIGTERM or SIGHUP end the program
// the way ctrl-c does, raw mode off and the cursor shown, rather than leaving the terminal raw.
//
// Node runs a signal's handler on its event loop, and a blocking `readSync` holds the loop, so a program waiting on
// a key would hear no signal until the key came. So the rounds read through `next` here instead: the terminal's input
// as a stream, which waits without holding the loop, and either the next bytes or, when a signal or the end of input
// comes first, empty text. `take` then says which signal it was.
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGTERM: 15, SIGWINCH: 28 }
const RESIZE = 28

const signals = (() => {
  // bytes read and not yet asked for, and the round waiting for them
  const queue: string[] = []
  let waiting: ((text: string) => void) | null = null
  // the last signal not yet taken, and the one that ended the program, 0 for none
  let pending = 0
  let stopped = 0
  let ended = false
  let reading = false
  const handlers = new Map<string, () => void>()

  const deliver = (text: string): void => {
    if (waiting) {
      const wake = waiting
      waiting = null
      wake(text)
    } else if (text !== '') {
      queue.push(text)
    }
  }

  return {
    // start answering the signals. True when they are watched
    watch(): boolean {
      for (const [name, signum] of Object.entries(SIGNAL_NUMBERS)) {
        const handler = (): void => {
          pending = signum

          if (signum !== RESIZE) {
            stopped = signum
          }

          deliver('')
        }

        handlers.set(name, handler)
        process.on(name as NodeJS.Signals, handler)
      }

      return true
    },

    // what the terminal sends next, or empty text when a signal or the end of input comes first
    next(): Promise<string> {
      if (!reading) {
        reading = true
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', chunk => deliver(String(chunk)))
        process.stdin.on('end', () => {
          ended = true
          deliver('')
        })
      }

      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!)
      }

      if (ended || pending !== 0) {
        return Promise.resolve('')
      }

      return new Promise(wake => {
        waiting = wake
      })
    },

    // the signal that arrived since the last ask, 0 for none
    take(): number {
      const signum = pending
      pending = 0

      return signum
    },

    // stop this process the way ctrl-z in a shell stops it, and return once the shell resumes it (`fg`). Raw mode turns
    // the terminal's own ctrl-z into a byte, so the program sends the stop to itself, after giving the terminal back.
    // Nothing handles SIGTSTP, so its default action stops the process where the signal is delivered, which is here
    suspend(): boolean {
      process.kill(process.pid, 'SIGTSTP')

      return true
    },

    // once the terminal is given back: the handlers removed and the input let go, so the program can end, and a program
    // a signal ended exits as a process killed by it would, 128 plus its number
    leave(): boolean {
      for (const [name, handler] of handlers) {
        process.off(name as NodeJS.Signals, handler)
      }

      handlers.clear()

      if (reading) {
        process.stdin.pause()
        process.stdin.unref?.()
      }

      if (stopped !== 0) {
        process.exitCode = 128 + stopped
      }

      return true
    },
  }
})()
