// Structured-concurrency runtime for rust. A job runs on the program's one-thread executor (compile/rust.ts,
// `__term_spawn`): it starts at once and runs to its first wait, the rest of it runs while its caller waits on something
// else, and a settle is a wait that runs the queued work until the job is no longer running (`__term_until`). Two jobs
// that each wait therefore wait at the same time, as on node.
//
// A RAISE inside `work` reaches the waiter as itself. The work's own type has no raise, so a raise in it is
// `__term_unhandled` (compile/rust-assemble.tree), which unwinds while `__TERM_CATCHING` is set; the job sets it while it
// polls its work and catches the unwind there, so the job is `failed` and code/task.tree's `wait` raises the same
// exception. A CANCELLED job is not polled again: it stops at its next wait and nothing after that wait runs. What the
// states mean is code/task.tree's. Reached only through the public task API.
mod job {
    use std::any::Any;
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::Pin;
    use std::rc::Rc;
    use std::task::{Context, Poll};

    pub struct Job {
        state: &'static str,
        result: Option<Rc<dyn Any>>,
        raised: Option<super::TermException>,
    }

    #[derive(Clone)]
    pub struct SeedJob(Rc<RefCell<Job>>);

    impl SeedJob {
        fn running(&self) -> bool {
            self.0.borrow().state == "running"
        }

        // the job's outcome, once: a cancel that came first keeps the job cancelled
        fn settle(&self, state: &'static str, result: Option<Rc<dyn Any>>, raised: Option<super::TermException>) {
            let mut job = self.0.borrow_mut();
            if job.state == "running" {
                job.state = state;
                job.result = result;
                job.raised = raised;
            }
        }
    }

    // a job's work as the executor polls it: stopped once the job is not running, and a raise inside it caught
    struct Run {
        job: SeedJob,
        work: Pin<Box<dyn Future<Output = Rc<dyn Any>>>>,
    }

    impl Future for Run {
        type Output = ();

        fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
            // cancelled: the work is dropped where it waits
            if !self.job.running() {
                return Poll::Ready(());
            }
            let held = super::__TERM_CATCHING.with(|c| c.replace(true));
            let polled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.work.as_mut().poll(context)));
            super::__TERM_CATCHING.with(|c| c.set(held));
            match polled {
                Ok(Poll::Pending) => Poll::Pending,
                Ok(Poll::Ready(value)) => {
                    self.job.settle("done", Some(value), None);
                    Poll::Ready(())
                }
                Err(unwound) => match unwound.downcast::<super::__TermUnwind>() {
                    Ok(raised) => {
                        self.job.settle("failed", None, Some(raised.0));
                        Poll::Ready(())
                    }
                    // not a raise: a defect, which goes on unwinding
                    Err(other) => std::panic::resume_unwind(other),
                },
            }
        }
    }

    pub fn spawn(work: Rc<dyn Fn() -> Pin<Box<dyn Future<Output = Rc<dyn Any>>>>>) -> SeedJob {
        let job = SeedJob(Rc::new(RefCell::new(Job { state: "running", result: None, raised: None })));
        // the work's future is made inside the catch too: an async closure runs nothing until it is polled, but a
        // synchronous part of the call that builds it may raise
        let held = job.clone();
        super::__term_spawn(Run { job: held, work: Box::pin(async move { work().await }) });
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

    // what a failed job raised, unchanged, so a typed exception reaches its waiter as itself. native/rust/job.tree
    // raises it
    pub fn raised(job: SeedJob) -> Option<super::TermException> {
        job.0.borrow().raised.clone()
    }

    pub fn cancel(job: SeedJob) {
        job.settle("cancelled", None, None);
    }

    pub fn alive(job: SeedJob) -> bool {
        job.running()
    }
}
