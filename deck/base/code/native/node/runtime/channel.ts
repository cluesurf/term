// Text channel runtime: an unbounded async queue. send hands the value to a waiting receiver or buffers it; receive
// takes a buffered value or waits for the next send. The opaque handle a seed channel holds is this queue object.
// Reached only through the public channel API.
type SeedChannel = {
  queue: string[]
  waiters: ((value: string) => void)[]
}

const channel = {
  make: (): SeedChannel => ({ queue: [], waiters: [] }),

  send: (target: SeedChannel, item: string): Promise<void> => {
    const waiter = target.waiters.shift()
    if (waiter) waiter(item)
    else target.queue.push(item)
    return Promise.resolve()
  },

  receive: (source: SeedChannel): Promise<string> =>
    new Promise(ok => {
      const value = source.queue.shift()
      if (value !== undefined) ok(value)
      else source.waiters.push(ok)
    }),

  close: (_target: SeedChannel): Promise<void> => Promise.resolve(),
}
