// Structured-concurrency runtime for Node: a job is a text-producing computation started eagerly when spawned. wait
// resolves its result; cancel requests cooperative cancellation and marks it finished; alive reports whether it is
// still running. The opaque handle a seed job holds is this object. Reached only through the public task API.
type SeedJob = {
  promise: Promise<string>
  alive: boolean
  cancelled: boolean
}

const job = {
  // start `work` immediately. `work` may be a synchronous or async closure (the async-closure lowering makes an async
  // one return a promise); either way the result is normalized to a promise and the alive flag flips when it settles.
  spawn: (work: () => string | Promise<string>): SeedJob => {
    const self: SeedJob = {
      promise: Promise.resolve(),
      alive: true,
      cancelled: false,
    } as unknown as SeedJob

    self.promise = Promise.resolve()
      .then(() => work())
      .then(
        result => {
          self.alive = false

          return result
        },
        error => {
          self.alive = false

          throw error
        },
      )

    return self
  },

  wait: (self: SeedJob): Promise<string> => self.promise,

  cancel: (self: SeedJob): void => {
    self.cancelled = true
    self.alive = false
  },

  alive: (self: SeedJob): boolean => self.alive,
}
