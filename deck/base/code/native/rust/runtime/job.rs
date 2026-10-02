// Structured-concurrency runtime for rust. A task's `work` is a synchronous function on this backend, so `spawn` runs
// it to completion and the job is settled before its handle exists. A raise inside `work` is a `TermException` the
// work's own signature cannot carry, so it ends the program the way an unhandled raise does on every backend; a job
// here is therefore always `done`. What the states mean is code/task.tree's. Reached only through the public task API.
mod job {
    use std::any::Any;
    use std::rc::Rc;

    #[derive(Clone)]
    pub struct SeedJob {
        result: Rc<dyn Any>,
    }

    pub fn spawn(work: Rc<dyn Fn() -> Rc<dyn Any>>) -> SeedJob {
        SeedJob { result: work() }
    }

    pub fn state(_job: SeedJob) -> String {
        "done".to_string()
    }

    pub fn result(job: SeedJob) -> Rc<dyn Any> {
        job.result.clone()
    }

    // never reached: no job here is ever `failed`, and code/task.tree asks for this only of a failed one
    pub fn rethrow(job: SeedJob) -> Rc<dyn Any> {
        job.result.clone()
    }

    pub fn cancel(_job: SeedJob) {}
}
