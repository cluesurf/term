// Clock runtime for the Web platform. `now` is the wall clock in milliseconds; `precise` is the monotonic timer, which
// is immune to the clock being adjusted and so is the one to measure durations with. Reached only through the public
// clock API.
let clockOrigin: number | undefined

const clock = {
  now: (): number => Date.now(),
  precise: (): number => Math.floor(performance.now()),
  // whole nanoseconds since the first call
  nanoseconds: (): number => {
    const at = performance.now()
    clockOrigin ??= at
    return Math.round((at - clockOrigin) * 1e6)
  },
  delay:(duration: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, duration)),
}
