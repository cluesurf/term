// Mutex runtime: an async flag lock. lock resolves immediately if free, else queues; unlock hands the lock to the next
// waiter or marks it free. The opaque handle a seed mutex holds is this object. Reached only through the public mutex API.
type SeedMutex = { locked: boolean; waiters: (() => void)[] }
const mutex = {
  make: (): SeedMutex => ({ locked: false, waiters: [] }),
  lock: (handle: SeedMutex): Promise<void> =>
    new Promise(ok => {
      if (!handle.locked) {
        handle.locked = true
        ok()
      } else handle.waiters.push(ok)
    }),
  unlock: (handle: SeedMutex): Promise<void> => {
    const waiter = handle.waiters.shift()
    if (waiter) waiter()
    else handle.locked = false
    return Promise.resolve()
  },
}
