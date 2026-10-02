// Filesystem watching for the rust target, over the `notify` crate -- the ecosystem-standard watcher, which uses
// FSEvents on macOS, inotify on Linux and ReadDirectoryChangesW on Windows rather than polling.
//
// The API is PULL, not callback: `watch_open` starts the watcher, `watch_next` awaits the next change, and
// `watch_close` stops it. That is the one shape all four backends can hold (node's fs.watch async iterator, this,
// Swift's DispatchSource, the JVM's WatchService), so the Term API above it is the same everywhere. A callback
// shape is not: it would need a `task` value crossing into a platform thread on three of the four.
//
// Reached only through the public file/watch API.
mod watch_file {
    use super::WatchEvent;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    // the running watcher: the notify handle is held only to keep it alive (dropping it stops the watch), and the
    // receiver is where changes arrive
    pub struct WatchState {
        pub keep: Option<notify::RecommendedWatcher>,
        pub take: tokio::sync::mpsc::UnboundedReceiver<WatchEvent>,
        // Closing the channel is not enough. `recv` drains what is already BUFFERED before it answers None, so a
        // change that landed just before `watch_close` is still delivered afterwards, and a caller looping until
        // the empty event gets one more change than the watcher was open for. This flag is the actual close.
        pub shut: bool,
    }

    pub type Watcher = Arc<Mutex<WatchState>>;

    fn name(kind: &notify::EventKind) -> &'static str {
        match kind {
            notify::EventKind::Create(_) => "create",
            notify::EventKind::Remove(_) => "remove",
            notify::EventKind::Modify(_) => "change",
            _ => "other",
        }
    }

    pub async fn watch_open(path: String, deep: bool) -> Watcher {
        use notify::Watcher as _;

        let (send, take) = tokio::sync::mpsc::unbounded_channel();
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
                let _ = watcher.watch(std::path::Path::new(&path), mode);

                Some(watcher)
            }
            Err(_) => None,
        };

        Arc::new(Mutex::new(WatchState {
            keep,
            take,
            shut: false,
        }))
    }

    // the next change. A closed watcher answers with the empty event rather than blocking forever, so a caller
    // that loops on `watch_next` terminates after `watch_close`.
    pub async fn watch_next(watcher: Watcher) -> WatchEvent {
        let mut state = watcher.lock().await;

        if state.shut {
            return WatchEvent {
                kind: String::new(),
                path: String::new(),
            };
        }

        match state.take.recv().await {
            Some(event) => event,
            None => WatchEvent {
                kind: String::new(),
                path: String::new(),
            },
        }
    }

    pub async fn watch_close(watcher: Watcher) {
        let mut state = watcher.lock().await;
        state.shut = true;
        state.keep = None;
        state.take.close();
    }
}
