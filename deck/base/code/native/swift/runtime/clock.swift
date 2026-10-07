// Clock runtime. `now` is the wall clock in milliseconds; `precise` is the monotonic timer, which is immune to the
// clock being adjusted and so is the one to measure durations with. Reached only through the public clock API.
//
// `currentTime` USED TO BE ProcessInfo.systemUptime, which is time since the machine booted, not time since the
// epoch. Every caller reading it as a wall clock got a number that was off by however long the machine had been
// up, and nothing failed: it is a plausible-looking count of milliseconds.
import Foundation

enum clock {
  static func now() -> Int {
    Int(Date().timeIntervalSince1970 * 1000)
  }

  // monotonic, and so unaffected by the wall clock being adjusted under a measurement
  static func precise() -> Int {
    Int(Foundation.ProcessInfo.processInfo.systemUptime * 1000)
  }

  // the origin of `nanoseconds`, taken at the first reading (a static is initialized once, lazily, thread-safely)
  private static let origin: UInt64 = DispatchTime.now().uptimeNanoseconds

  // whole nanoseconds since the first reading, never decreasing
  static func nanoseconds() -> Int {
    // the origin is read FIRST: a lazy static is set on its first use, so reading the time before it would make the
    // first reading earlier than its own origin
    let from = origin
    return Int(DispatchTime.now().uptimeNanoseconds - from)
  }

  // what `clock/now` reads: monotonic milliseconds on every backend (note/term/stdlib/semantics.md). Every caller
  // subtracts two readings; the wall clock is `time/now`
  static func currentTime() -> Int {
    precise()
  }

  static func sleep(_ ms: Int) {
    Thread.sleep(forTimeInterval: Double(max(0, ms)) / 1000.0)
  }
}
