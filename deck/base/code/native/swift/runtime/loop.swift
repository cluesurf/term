// The program's one loop on swift, as far as Swift lets a program see it
// (note/project/term/decision/001-native-work-hands-back-to-the-loop.md, term-stdlib-parity-0014). Swift has no
// executor of Term's own: a task runs on Swift's, and a wait that nothing will ever end just hangs there. Rust's
// `__term_block_on` and Kotlin's `termLoop.block` stop instead, with "the program waits on work that nothing can
// finish", when nothing is ready to run, no timer is set and nothing is handed out. This counts the same three things
// so Swift stops the same way:
//
//   running   the program's tasks that are running or woken: the entry, and every job or tick it started
//   pending   the timers set (a delay, a wait with a limit) and the work handed out (`aio.handBack`)
//
// A task waits through `leave` (a channel receive, a wait on a job, a mutex) and is woken through `wake`, by WHOEVER
// resumes it and before it resumes, so no wait can see the count fall to zero while a wake is on its way. A timer or
// a hand-back is `hold` and `release` around the wait: it is pending while it lasts. The stop is checked where the
// count falls.
//
// Only the program's own tasks are counted (the task-local `counted`, set by `entry` and passed to every job and tick
// they start). A wait in a task the program did not start (a server's handler, a native callback) moves nothing, and
// a wait in a counted task that does not come through here (an HTTP request, a watch) leaves it running: either way
// the loop can only fail to see a stall, never see one that is not. Nothing is counted at all until `entry` runs, so a
// program whose entry is not asynchronous never stops here.
//
// Docked as `<global:loop>, name term-loop` by every swift module whose shim waits through it (channel, job, clock,
// mutex, and the file modules that dock `aio`): the alias is the namespace's name, and a program's own `loop` task
// would redeclare a bare `loop`. Reached only through those shims and the main (compile/main-entry.tree, which wraps
// an asynchronous entry in `termLoop.entry` when the program defines `__termLoopEntry`).
import Foundation

enum termLoop {
  @TaskLocal static var counted = false

  private static let lock = NSLock()
  // guarded by `lock`
  nonisolated(unsafe) private static var on = false
  nonisolated(unsafe) private static var running = 0
  nonisolated(unsafe) private static var pending = 0

  // the asynchronous entry, counted as the first running task
  static func entry<T>(_ body: () async throws -> T) async rethrows -> T {
    begin()
    return try await $counted.withValue(true) { try await body() }
  }

  // an NSLock is not taken in an asynchronous function itself
  private static func begin() {
    lock.lock()
    on = true
    running += 1
    lock.unlock()
  }

  // a counted task starts another: counted from before it exists, so no wait can miss it. Answers whether it was
  static func start() -> Bool {
    guard counted else { return false }
    lock.lock()
    running += 1
    lock.unlock()
    return true
  }

  // a counted task ends: its body returned, or a cancelled one stopped for good at a wait
  static func end(_ was: Bool) {
    guard was else { return }
    lock.lock()
    running -= 1
    stall()
    lock.unlock()
  }

  // the current task waits on another task. Answers whether it was counted, which its waker passes to `wake`
  static func leave() -> Bool {
    guard counted else { return false }
    lock.lock()
    running -= 1
    stall()
    lock.unlock()
    return true
  }

  // a waiting task is resumed: called by its waker before the resume
  static func wake(_ was: Bool) {
    guard was else { return }
    lock.lock()
    running += 1
    lock.unlock()
  }

  // the current task waits on a timer or on handed-out work, which is pending while it lasts
  static func hold() -> Bool {
    guard counted else { return false }
    lock.lock()
    running -= 1
    pending += 1
    lock.unlock()
    return true
  }

  // that wait ended and the task runs again
  static func release(_ was: Bool) {
    guard was else { return }
    lock.lock()
    pending -= 1
    running += 1
    lock.unlock()
  }

  // nothing running, no timer, nothing handed out: nothing can ever wake the program. Called holding the lock
  private static func stall() {
    if on && running <= 0 && pending == 0 {
      FileHandle.standardError.write(Data("defect: the program waits on work that nothing can finish\n".utf8))
      exit(1)
    }
  }
}
