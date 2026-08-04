// Clock runtime for the Web platform. `now` is the wall clock in milliseconds; `precise` is the monotonic timer, which
// is immune to the clock being adjusted and so is the one to measure durations with. Reached only through the public
// clock API.
const clock = {
  now: (): number => Date.now(),
  precise: (): number => performance.now(),
  delay: (duration: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, duration)),
}
