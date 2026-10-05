// Structured-concurrency runtime for rust. A job runs on the program's one-thread executor (compile/rust.ts,
// `__term_spawn`): it starts at once and runs to its first wait, the rest of it runs while its caller waits on something
// else, and a settle is a wait that runs the queued work until the job is no longer running (`__term_until`). Two jobs
// that each wait therefore wait at the same time, as on node. A raise inside `work` is a `TermException` the work's own
// signature cannot carry, so it ends the program the way an unhandled raise does on every backend; a job here is
// therefore never `failed`. A cancelled job's work is not stopped, its answer is dropped when it arrives, which is what
// code/task.tree asks of a cancel. What the states mean is code/task.tree's. Reached only through the public task API.
mod job {
    use std::any::Any;
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::Pin;
    use std::rc::Rc;

    pub struct Job {
        state: &'static str,
        result: Option<Rc<dyn Any>>,
    }

    #[derive(Clone)]
    pub struct SeedJob(Rc<RefCell<Job>>);

    impl SeedJob {
        fn running(&self) -> bool {
            self.0.borrow().state == "running"
        }
    }

    pub fn spawn(work: Rc<dyn Fn() -> Pin<Box<dyn Future<Output = Rc<dyn Any>>>>>) -> SeedJob {
        let job = SeedJob(Rc::new(RefCell::new(Job { state: "running", result: None })));
        let held = job.clone();
        super::__term_spawn(async move {
            let value = work().await;
            let mut settled = held.0.borrow_mut();
            if settled.state == "running" {
                settled.state = "done";
                settled.result = Some(value);
            }
        });
        job
    }

    pub async fn settle(job: SeedJob) {
        super::__term_until(move || !job.running()).await
    }

    // true when the job stopped running before `milliseconds` passed
    pub async fn settle_within(job: SeedJob, milliseconds: i64) -> bool {
        let at = std::time::Instant::now() + std::time::Duration::from_millis(milliseconds.max(0) as u64);
        let timer = Rc::new(RefCell::new(super::__term_sleep(milliseconds)));
        let watched = job.clone();
        super::__term_until(move || {
            if !watched.running() || std::time::Instant::now() >= at {
                return true;
            }
            // poll the timer so the driver knows when to wake if nothing else runs
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            let _ = Pin::new(&mut *timer.borrow_mut()).poll(&mut context);
            false
        })
        .await;
        !job.running()
    }

    // every job stopped, or the first one failed or was cancelled
    pub async fn settle_group(jobs: Rc<RefCell<Vec<SeedJob>>>) {
        super::__term_until(move || {
            let jobs = jobs.borrow();
            jobs.iter().all(|job| !job.running()) || jobs.iter().any(|job| matches!(job.0.borrow().state, "failed" | "cancelled"))
        })
        .await
    }

    // any one job stopped, for any reason
    pub async fn settle_any(jobs: Rc<RefCell<Vec<SeedJob>>>) {
        super::__term_until(move || jobs.borrow().iter().any(|job| !job.running())).await
    }

    pub fn state(job: SeedJob) -> String {
        job.0.borrow().state.to_string()
    }

    pub fn result(job: SeedJob) -> Rc<dyn Any> {
        job.0.borrow().result.clone().unwrap_or_else(|| Rc::new(()))
    }

    // never reached: no job here is ever `failed`, and code/task.tree asks for this only of a failed one
    pub fn rethrow(job: SeedJob) -> Rc<dyn Any> {
        result(job)
    }

    pub fn cancel(job: SeedJob) {
        let mut settled = job.0.borrow_mut();
        if settled.state == "running" {
            settled.state = "cancelled";
        }
    }

    pub fn alive(job: SeedJob) -> bool {
        job.running()
    }
}
