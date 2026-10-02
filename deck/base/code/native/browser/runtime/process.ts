// Current-process runtime for the Web platform. A page is not a process, so each of these is the nearest honest
// equivalent: the URL path stands in for the working directory, the full URL for the executable, and closing the
// window or worker for exiting. Reached only through the public process API.
const process = {
  directory: (): string => location.pathname,

  executable: (): string => location.href,

  // a page cannot exit; a dedicated worker can close itself, and a window can close only if it was script-opened
  exit: (): void => {
    if (
      typeof self !== 'undefined' &&
      typeof self.close === 'function' &&
      typeof window === 'undefined'
    ) {
      self.close()
    } else if (typeof window !== 'undefined') {
      window.close()
    }
  },

  // `beforeunload` is the closest thing to a termination signal a page receives
  onExit: (handler: () => void): void => {
    window.addEventListener('beforeunload', handler)
  },

  // a page is never told it is being suspended, only that it became hidden
  onHide: (handler: () => void): void => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        handler()
      }
    })
  },

  // worker-to-worker piping: forward every message from one to the other
  pipe: (from: Worker, to: Worker): void => {
    from.addEventListener('message', event => {
      to.postMessage((event as MessageEvent).data)
    })
  },

  // a page cannot spawn a process; a Worker is the nearest equivalent, so `command` is read as a worker script URL
  makeWorker: (url: string): Worker => new Worker(url),

  nextWorkerId: (() => {
    let count = 0

    return (): number => {
      count += 1

      return count
    }
  })(),

  // run a worker to completion and shape its outcome like a process result. A worker has no exit code or stderr, so
  // a clean message is code 0 and any error or timeout is code 1 with the reason as stderr.
  runWorker: (
    worker: Worker,
    input: string | null,
    timeout: number | null,
  ): Promise<{
    code: number
    stdout: string
    stderr: string
    ok: boolean
  }> =>
    new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (
        code: number,
        stdout: string,
        stderr: string,
      ) => {
        if (timer) {
          clearTimeout(timer)
        }

        worker.terminate()
        resolve({ code, stdout, stderr, ok: code === 0 })
      }

      worker.onmessage = event => {
        const data = (event as MessageEvent).data

        settle(
          0,
          typeof data === 'string' ? data : JSON.stringify(data),
          '',
        )
      }

      worker.onerror = event => {
        settle(1, '', (event as ErrorEvent).message || 'worker error')
      }

      if (timeout) {
        timer = setTimeout(() => settle(1, '', 'timeout'), timeout)
      }

      if (input != null) {
        worker.postMessage(input)
      }
    }),

  // a worker signals completion by posting `{ type: 'exit' }`; an error resolves as exit code 1
  waitWorker: (worker: Worker): Promise<number> =>
    new Promise(resolve => {
      worker.addEventListener('message', event => {
        const data = (event as MessageEvent).data

        if (data && data.type === 'exit') {
          resolve(data.code || 0)
        }
      })

      worker.addEventListener('error', () => resolve(1))
    }),

  // collect every non-control message until the worker signals exit, then join them as the output
  readWorker: (worker: Worker): Promise<string> =>
    new Promise(resolve => {
      const chunks: string[] = []

      worker.addEventListener('message', event => {
        const data = (event as MessageEvent).data

        if (data && data.type === 'exit') {
          resolve(chunks.join(''))
        } else {
          chunks.push(typeof data === 'string' ? data : JSON.stringify(data))
        }
      })

      worker.addEventListener('error', () => resolve(chunks.join('')))
    }),

  // forward every non-control message into the caller's list as it arrives
  streamWorker: (worker: Worker, messages: unknown[]): void => {
    worker.addEventListener('message', event => {
      const data = (event as MessageEvent).data

      if (data && data.type !== 'exit' && data.type !== 'close') {
        messages.push(data)
      }
    })
  },
}
