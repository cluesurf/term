// Structured-concurrency runtime for Node: a job is a text-producing computation started eagerly when spawned. This
// shim holds STATE and nothing else. What a state means (a cancelled job's `wait` raises `outage`, a timed-out one
// `timeout`, a `gather` with one failure cancels the rest) is decided in Term, in code/task.tree, so every backend
// raises the same typed exceptions and each backend's shim only has to report these five states:
//
//   running     started, not settled
//   done        settled with a result
//   failed      settled by raising. The raised value is kept whole, so a typed Term exception reaches the waiter as
//               itself rather than as a wrapped error
//   cancelled   cancelled before it settled. Its result, or its raise, is discarded when it arrives
//
// WHAT CANCEL CAN AND CANNOT DO HERE. A JavaScript promise cannot be stopped from outside, so a cancelled job's
// in-flight step runs to its next settle and its result is thrown away. What cancel guarantees is that nothing waits
// on the job and nothing it raises afterwards surfaces: before this, an unawaited job that raised was an unhandled
// rejection, which ends the Node process. Stopping the work itself needs a worker, which is note/term/research/
// beam-otp-lessons.md design 1's later half. Reached only through the public task API.
type SeedJob = {
  promise: Promise<void>
  state: 'running' | 'done' | 'failed' | 'cancelled'
  result: string
  error: unknown
  // resolvers of every `settle` waiting on this job, released by settling OR by cancel
  waiting: (() => void)[]
}

const release = (self: SeedJob): void => {
  const waiting = self.waiting

  self.waiting = []

  for (const resolve of waiting) {
    resolve()
  }
}

const job = {
  // start `work` immediately. `work` may be a synchronous or async closure (the async-closure lowering makes an async
  // one return a promise); either way it is normalized to a promise, and the promise NEVER rejects: its outcome is
  // recorded on the job, so no job can become an unhandled rejection whoever stops waiting for it
  spawn: (work: () => string | Promise<string>): SeedJob => {
    const self: SeedJob = {
      promise: Promise.resolve(),
      state: 'running',
      result: '',
      error: undefined,
      waiting: [],
    }

    self.promise = Promise.resolve()
      .then(() => work())
      .then(
        result => {
          if (self.state === 'running') {
            self.state = 'done'
            self.result = result
          }

          release(self)
        },
        error => {
          if (self.state === 'running') {
            self.state = 'failed'
            self.error = error
          }

          release(self)
        },
      )

    return self
  },

  // resolve once the job is no longer running: settled, or cancelled
  settle: (self: SeedJob): Promise<void> =>
    self.state === 'running'
      ? new Promise<void>(resolve => self.waiting.push(resolve))
      : Promise.resolve(),

  // the same, giving up after `ms` milliseconds: true when it stopped running in time
  settleWithin: (self: SeedJob, ms: number): Promise<boolean> => {
    if (self.state !== 'running') {
      return Promise.resolve(true)
    }

    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), Math.max(0, ms))

      self.waiting.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  },

  // resolve once every job has stopped running, or as soon as ONE has failed or been cancelled: what `gather` waits
  // for, so the first failure is seen when it happens rather than after every job before it in the list
  settleGroup: (jobs: SeedJob[]): Promise<void> =>
    new Promise<void>(resolve => {
      let left = jobs.length
      let over = false
      const finish = (): void => {
        if (!over) {
          over = true
          resolve()
        }
      }

      if (left === 0) {
        finish()

        return
      }

      for (const one of jobs) {
        void job.settle(one).then(() => {
          left--

          if (one.state !== 'done' || left === 0) {
            finish()
          }
        })
      }
    }),

  state: (self: SeedJob): string => self.state,

  result: (self: SeedJob): string => self.result,

  // raise what the job raised, unchanged
  rethrow: (self: SeedJob): string => {
    throw self.error
  },

  cancel: (self: SeedJob): void => {
    if (self.state === 'running') {
      self.state = 'cancelled'
      release(self)
    }
  },

  alive: (self: SeedJob): boolean => self.state === 'running',
}
