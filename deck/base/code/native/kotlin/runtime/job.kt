// Structured-concurrency runtime for kotlin. A job is a coroutine started at once on the caller's thread: it runs to its
// first wait, and the rest of it runs on the program's event loop (`termLoop`) while its caller waits on something else,
// so two jobs that each wait wait at the same time, as on node. Every coroutine runs on that one loop, so a job's state
// is read and written by one thread. A raise inside `work` is caught and kept whole, so the job is `failed` and
// code/task.tree's `wait` raises the same exception. A cancelled job's answer is dropped when it arrives. Every settle
// is a wait on the job's own state, woken when it changes, never a poll. Reached only through the public task API.
class SeedJob {
    var state: String = "running"
        private set
    var result: Any? = null
        private set
    var error: Throwable? = null
        private set
    private val watchers = mutableListOf<() -> Unit>()

    // the job's outcome, once: a cancel that came first keeps the job cancelled
    fun settle(state: String, result: Any?, error: Throwable?) {
        if (this.state != "running") return
        this.state = state
        this.result = result
        this.error = error
        val woken = watchers.toList()
        watchers.clear()
        woken.forEach { it() }
    }

    // run `watch` once the job is no longer running: now, if it already is not
    fun onSettled(watch: () -> Unit) {
        if (state != "running") watch() else watchers.add(watch)
    }
}

object job {
    // `Any?`: the work's result is a generic `R`, which Kotlin lets be null
    fun spawn(work: suspend () -> Any?): SeedJob {
        val started = SeedJob()
        work.startCoroutine(object : kotlin.coroutines.Continuation<Any?> {
            override val context: kotlin.coroutines.CoroutineContext = kotlin.coroutines.EmptyCoroutineContext
            override fun resumeWith(result: Result<Any?>) {
                result.fold({ started.settle("done", it, null) }, { started.settle("failed", null, it) })
            }
        })
        return started
    }

    suspend fun settle(job: SeedJob) {
        if (job.state != "running") return
        kotlin.coroutines.suspendCoroutine<Unit> { waiting -> job.onSettled { waiting.resume(Unit) } }
    }

    // true when the job stopped running before `milliseconds` passed
    suspend fun settleWithin(job: SeedJob, milliseconds: Long): Boolean {
        if (job.state == "running") {
            kotlin.coroutines.suspendCoroutine<Unit> { waiting ->
                var woken = false
                val wake = { if (!woken) { woken = true; waiting.resume(Unit) } }
                job.onSettled(wake)
                termLoop.after(milliseconds, wake)
            }
        }
        return job.state != "running"
    }

    // every job stopped, or the first one failed or was cancelled
    suspend fun settleGroup(jobs: MutableList<SeedJob>) {
        while (true) {
            val running = jobs.filter { it.state == "running" }
            if (running.isEmpty() || jobs.any { it.state == "failed" || it.state == "cancelled" }) return
            settleAny(running.toMutableList())
        }
    }

    // any one job stopped, for any reason
    suspend fun settleAny(jobs: MutableList<SeedJob>) {
        if (jobs.isEmpty() || jobs.any { it.state != "running" }) return
        kotlin.coroutines.suspendCoroutine<Unit> { waiting ->
            var woken = false
            jobs.forEach { it.onSettled { if (!woken) { woken = true; waiting.resume(Unit) } } }
        }
    }

    fun state(job: SeedJob): String = job.state

    fun result(job: SeedJob): Any = job.result ?: Unit

    // what a failed job raised, unchanged, so a typed exception reaches its waiter as itself
    fun rethrow(job: SeedJob): Any = throw job.error ?: IllegalStateException("job did not fail")

    fun cancel(job: SeedJob) = job.settle("cancelled", null, null)

    fun alive(job: SeedJob): Boolean = job.state == "running"
}
