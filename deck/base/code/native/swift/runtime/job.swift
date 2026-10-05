// Structured-concurrency runtime for swift. A job is a Swift task started at once on the caller's thread
// (`Task.immediate`, SE-0472, where the OS has it): it runs to its first wait, and the rest of it runs while its caller
// waits on something else, so two jobs that each wait wait at the same time, as on node. A raise inside `work` is
// caught and kept, so the job is `failed` and code/task.tree's `wait` raises the same exception. A cancelled job's task
// is cancelled and its answer dropped. Every settle is a wait on the job's own state, woken when it changes, never a
// poll. What the states mean is code/task.tree's. Reached only through the public task API.
final class SeedJob: @unchecked Sendable {
    private let lock = NSLock()
    private var current = "running"
    private var answer: Any = ()
    private var raised: Error? = nil
    private var watchers: [() -> Void] = []
    fileprivate var task: Task<Void, Never>? = nil

    var state: String { lock.lock(); defer { lock.unlock() }; return current }
    var result: Any { lock.lock(); defer { lock.unlock() }; return answer }
    var error: Error? { lock.lock(); defer { lock.unlock() }; return raised }

    // the job's outcome, once: a cancel that came first keeps the job cancelled
    fileprivate func settle(_ state: String, _ result: Any, _ error: Error?) {
        lock.lock()
        guard current == "running" else { lock.unlock(); return }
        current = state
        answer = result
        raised = error
        let woken = watchers
        watchers = []
        lock.unlock()
        woken.forEach { $0() }
    }

    // run `watch` once the job is no longer running: now, if it already is not
    fileprivate func onSettled(_ watch: @escaping () -> Void) {
        lock.lock()
        if current != "running" { lock.unlock(); watch(); return }
        watchers.append(watch)
        lock.unlock()
    }
}

// one wake for a wait several things may end: the first to fire resumes it, the rest find it already resumed
final class SeedJobOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: CheckedContinuation<Void, Never>?

    init(_ waiting: CheckedContinuation<Void, Never>) { self.waiting = waiting }

    func fire() {
        lock.lock()
        let resumed = waiting
        waiting = nil
        lock.unlock()
        resumed?.resume()
    }
}

enum job {
    static func spawn(_ work: @escaping () async throws -> Any) -> SeedJob {
        let started = SeedJob()
        let body: () async -> Void = {
            do { started.settle("done", try await work(), nil) } catch { started.settle("failed", (), error) }
        }
        if #available(macOS 26, iOS 26, tvOS 26, watchOS 26, visionOS 26, *) {
            started.task = Task.immediate { await body() }
        } else {
            started.task = Task { await body() }
        }
        return started
    }

    static func settle(_ job: SeedJob) async {
        await withCheckedContinuation { (waiting: CheckedContinuation<Void, Never>) in
            job.onSettled { waiting.resume() }
        }
    }

    // true when the job stopped running before `milliseconds` passed
    static func settleWithin(_ job: SeedJob, _ milliseconds: Int) async -> Bool {
        await withCheckedContinuation { (waiting: CheckedContinuation<Void, Never>) in
            let once = SeedJobOnce(waiting)
            job.onSettled { once.fire() }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(milliseconds, 0)) * 1_000_000)
                once.fire()
            }
        }
        return job.state != "running"
    }

    // every job stopped, or the first one failed or was cancelled
    static func settleGroup(_ jobs: SeedList<SeedJob>) async {
        while true {
            let running = jobs.data.filter { $0.state == "running" }
            if running.isEmpty || jobs.data.contains(where: { $0.state == "failed" || $0.state == "cancelled" }) { return }
            await settleAny(SeedList(running))
        }
    }

    // any one job stopped, for any reason
    static func settleAny(_ jobs: SeedList<SeedJob>) async {
        await withCheckedContinuation { (waiting: CheckedContinuation<Void, Never>) in
            let once = SeedJobOnce(waiting)
            if jobs.data.isEmpty { once.fire() }
            jobs.data.forEach { $0.onSettled { once.fire() } }
        }
    }

    static func state(_ job: SeedJob) -> String { job.state }
    static func result(_ job: SeedJob) -> Any { job.result }

    // what a failed job raised, unchanged, so a typed exception reaches its waiter as itself
    static func rethrow(_ job: SeedJob) throws -> Any {
        if let raised = job.error { throw raised }
        return job.result
    }

    static func cancel(_ job: SeedJob) {
        job.task?.cancel()
        job.settle("cancelled", (), nil)
    }

    static func alive(_ job: SeedJob) -> Bool { job.state == "running" }
}
