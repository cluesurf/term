// Structured-concurrency runtime for swift. A task's `work` is a synchronous function on this backend, so `spawn` runs
// it to completion and the job is settled before its handle exists. What the states mean is code/task.tree's. Reached
// only through the public task API.
final class SeedJob {
    let result: Any

    init(result: Any) {
        self.result = result
    }
}

enum job {
    static func spawn(_ work: () -> Any) -> SeedJob { SeedJob(result: work()) }
    static func state(_ job: SeedJob) -> String { "done" }
    static func result(_ job: SeedJob) -> Any { job.result }
    // never reached: no job here is ever `failed`, and code/task.tree asks for this only of a failed one
    static func rethrow(_ job: SeedJob) -> Any { job.result }
    static func cancel(_ job: SeedJob) {}
}
