// Channel runtime: an unbounded async queue. send hands the value to a waiting receiver or buffers it; receive takes a
// buffered value or waits for the next send. A message is any Term value: the public `channel` form is what types it.
// The opaque handle a seed channel holds is this queue object. Reached only through the public channel API.
type SeedChannel = {
  // a buffered message is boxed in a one-field record, so an `undefined` or a void message is still a message rather
  // than an empty slot
  queue: { value: unknown }[]
  waiters: ((value: unknown) => void)[]
}

const channel = {
  make: (): SeedChannel => ({ queue: [], waiters: [] }),

  send: (target: SeedChannel, item: unknown): Promise<void> => {
    const waiter = target.waiters.shift()

    if (waiter) {
      waiter(item)
    } else {
      target.queue.push({ value: item })
    }

    return Promise.resolve()
  },

  receive: (source: SeedChannel): Promise<unknown> =>
    new Promise(ok => {
      const held = source.queue.shift()

      if (held) {
        ok(held.value)
      } else {
        source.waiters.push(ok)
      }
    }),

  close: (_target: SeedChannel): Promise<void> => Promise.resolve(),
}
