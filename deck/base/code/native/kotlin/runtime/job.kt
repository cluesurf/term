// Structured-concurrency runtime for kotlin. A task's `work` is a synchronous function on this backend, so `spawn` runs
// it to completion and the job is settled before its handle exists. A raise inside `work` is an exception, caught here
// and kept whole, so the job is `failed` and code/task.tree's `wait` raises the same exception, as on node. Reached only
// through the public task API.
class SeedJob(val state: String, val result: Any?, val error: Throwable?)

object job {
    fun spawn(work: () -> Any): SeedJob =
        try {
            SeedJob("done", work(), null)
        } catch (raised: Throwable) {
            SeedJob("failed", null, raised)
        }

    fun state(job: SeedJob): String = job.state

    fun result(job: SeedJob): Any = job.result ?: Unit

    fun rethrow(job: SeedJob): Any = throw job.error ?: IllegalStateException("job did not fail")

    fun cancel(job: SeedJob) {}
}
