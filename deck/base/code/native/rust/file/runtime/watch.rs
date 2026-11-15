// Filesystem watching for the rust target, over the `notify` crate -- the ecosystem-standard watcher, which uses
// FSEvents on macOS, inotify on Linux and ReadDirectoryChangesW on Windows rather than polling.
//
// The API is PULL, not callback: `watch_open` starts the watcher, `watch_next` awaits the next change, and
// `watch_close` stops it. That is the one shape all four backends can hold (node's fs.watch async iterator, this,
// Swift's DispatchSource, the JVM's WatchService), so the Term API above it is the same everywhere. A callback
// shape is not: it would need a `task` value crossing into a platform thread on three of the four.
//
// The wait for the next change is HANDED BACK (note/project/term/decision/001-native-work-hands-back-to-the-loop.md):
// `crate::__term_hand_back` blocks a worker on the channel and wakes the loop when a change arrives, as aio.rs does
// for a read. A tokio channel awaited in place only woke a tokio executor, and a program built as `term make --build`
// builds one runs on Term's own loop, which saw a wait nothing would finish and stopped (item 1143).
//
// Reached only through the public file/watch API.
mod watch_file {
    use super::WatchEvent;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver};
    use std::sync::{Arc, Mutex};

    // the running watcher: the notify handle is held only to keep it alive (dropping it stops the watch and drops the
    // sender, so a worker waiting on `take` answers), and the receiver is where changes arrive
    pub struct WatchState {
        pub keep: Mutex<Option<notify::RecommendedWatcher>>,
        pub take: Mutex<Receiver<WatchEvent>>,
        // Closing the channel is not enough. `recv` drains what is already BUFFERED before it answers an error, so a
        // change that landed just before `watch_close` is still delivered afterwards, and a caller looping until
        // the empty event gets one more change than the watcher was open for. This flag is the actual close.
        pub shut: AtomicBool,
        // what the host refused when the watch was opened (refusal.rs), the empty code name when it opened: file/watch
        // raises it (term-self-host-001-1519)
        pub refusal: Vec<String>,
    }

    // runtime-include: refusal.rs

    // a notify error as a refusal of the `watch` step: an io error by its code, a path notify found missing as ENOENT
    fn notify_refused(failure: notify::Error) -> Vec<String> {
        let text = failure.to_string();

        match failure.kind {
            notify::ErrorKind::Io(failure) => refused(&failure, "watch"),
            notify::ErrorKind::PathNotFound => vec!["ENOENT".to_string(), "watch".to_string(), text],
            _ => vec!["?".to_string(), "watch".to_string(), text],
        }
    }

    pub type Watcher = Arc<WatchState>;

    fn name(kind: &notify::EventKind) -> &'static str {
        match kind {
            notify::EventKind::Create(_) => "create",
            notify::EventKind::Remove(_) => "remove",
            notify::EventKind::Modify(_) => "change",
            _ => "other",
        }
    }

    fn empty() -> WatchEvent {
        WatchEvent {
            kind: String::new(),
            path: String::new(),
        }
    }

    // A path is refused where node's fs.watch refuses it: node opens the path to read first (libuv's open(2) on darwin,
    // inotify's read check on Linux), so a missing path is ENOENT, one under a file ENOTDIR and one the run may not read
    // EACCES, though FSEvents would watch the last. The open is that same check, closed at once
    pub async fn watch_open(path: String, deep: bool) -> Watcher {
        use notify::Watcher as _;

        let (send, take) = channel();

        if let Err(failure) = std::fs::File::open(&path) {
            return Arc::new(WatchState {
                keep: Mutex::new(None),
                take: Mutex::new(take),
                shut: AtomicBool::new(true),
                refusal: refused(&failure, "watch"),
            });
        }

        let mut refusal = carried();
        let watcher = notify::recommended_watcher(
            move |event: notify::Result<notify::Event>| {
                let event = match event {
                    Ok(event) => event,
                    Err(_) => return,
                };

                for at in event.paths {
                    let _ = send.send(WatchEvent {
                        kind: name(&event.kind).to_string(),
                        path: at.to_string_lossy().to_string(),
                    });
                }
            },
        );

        let keep = match watcher {
            Ok(mut watcher) => {
                let mode = if deep {
                    notify::RecursiveMode::Recursive
                } else {
                    notify::RecursiveMode::NonRecursive
                };
                match watcher.watch(std::path::Path::new(&path), mode) {
                    Ok(_) => Some(watcher),
                    Err(failure) => {
                        refusal = notify_refused(failure);
                        None
                    }
                }
            }
            Err(failure) => {
                refusal = notify_refused(failure);
                None
            }
        };
        let shut = keep.is_none();

        Arc::new(WatchState {
            keep: Mutex::new(keep),
            take: Mutex::new(take),
            shut: AtomicBool::new(shut),
            refusal,
        })
    }

    pub fn watch_refusal(watcher: Watcher) -> Vec<String> {
        watcher.refusal.clone()
    }

    // the next change. A closed watcher answers with the empty event rather than blocking forever, so a caller
    // that loops on `watch_next` terminates after `watch_close`.
    pub async fn watch_next(watcher: Watcher) -> WatchEvent {
        if watcher.shut.load(Ordering::SeqCst) {
            return empty();
        }

        crate::__term_hand_back(move || {
            let take = match watcher.take.lock() {
                Ok(take) => take,
                Err(_) => return empty(),
            };

            match take.recv() {
                Ok(event) if !watcher.shut.load(Ordering::SeqCst) => event,
                _ => empty(),
            }
        })
        .await
    }

    pub async fn watch_close(watcher: Watcher) {
        watcher.shut.store(true, Ordering::SeqCst);

        if let Ok(mut keep) = watcher.keep.lock() {
            *keep = None;
        }
    }
}
