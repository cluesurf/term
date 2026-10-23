// Structured-concurrency runtime for the Web platform: node's runtime/job.ts without `node:async_hooks`. A job is
// started eagerly when spawned, and this shim holds its STATE and nothing else. What a state means (a cancelled job's
// `wait` raises `outage`, a timed-out one `timeout`, a `gather` with one failure cancels the rest) is decided in Term, in
// code/task.tree, so the browser raises the same typed exceptions as every other backend:
//
//   running     started, not settled
//   done        settled with a result
//   failed      settled by raising, the raised value kept whole
//   cancelled   cancelled before it settled. Its result, or its raise, is discarded when it arrives
//
// WHAT CANCEL DOES HERE. A page has no AsyncLocalStorage (TC39's AsyncContext has not shipped), so no wait can tell
// which job it runs in, and a cancelled job's work runs on to its end. Nothing waits on it any more, and its outcome is
// discarded, so nothing it does afterwards surfaces as a result or an unhandled rejection. On node its next wait never
// ends instead (native/node/runtime/job.ts). Reached only through the public task API.
type SeedJob = {
  promise: Promise<void>
  state: 'running' | 'done' | 'failed' | 'cancelled'
  // any Term value: the public `handle` form is what types it
  result: unknown
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
  // start `work` at once. Its promise never rejects: the outcome is recorded on the job
  spawn: (work: () => unknown): SeedJob => {
    const self: SeedJob = {
      promise: Promise.resolve(),
      state: 'running',
      result: undefined,
      error: undefined,
      waiting: [],
    }

    self.promise = Promise.resolve()
      .then(work)
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
  settle: async (self: SeedJob): Promise<void> => {
    if (self.state === 'running') {
      await new Promise<void>(resolve => self.waiting.push(resolve))
    }
  },

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

  // resolve once every job has stopped running, or as soon as ONE has failed or been cancelled
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

  // resolve as soon as ANY job has stopped running, for any reason
  settleAny: (jobs: SeedJob[]): Promise<void> =>
    new Promise<void>(resolve => {
      let over = false
      const finish = (): void => {
        if (!over) {
          over = true
          resolve()
        }
      }

      if (jobs.length === 0 || jobs.some(one => one.state !== 'running')) {
        finish()

        return
      }

      for (const one of jobs) {
        void job.settle(one).then(finish)
      }
    }),

  state: (self: SeedJob): string => self.state,

  result: (self: SeedJob): unknown => self.result,

  // raise what the job raised, unchanged
  rethrow: (self: SeedJob): unknown => {
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
