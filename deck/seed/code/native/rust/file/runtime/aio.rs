// Asynchronous filesystem runtime for the rust target, over `tokio::fs` -- the ecosystem-standard async filesystem
// API, not a thread pool of our own. Every function here is `async fn`, which is what `note async` in the calling
// `.tree` lowers to, so the await chain runs on the caller's tokio runtime.
//
// TOTAL, LIKE THE REST OF THE NATIVE SURFACE. tokio returns `io::Result`; the public file API has no error channel,
// so a failure reads as the empty / false / zero answer here rather than unwinding through emitted code that has no
// way to catch it. The one place that is wrong is a handle op, where a missing file cannot be papered over, and
// `handle_open` says so by panicking on a path it cannot open.
//
// Reached only through the public file API. See note/term/stdlib/native-async-file-and-server.md.
mod aio {
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
    use tokio::sync::Mutex;

    // an open file, shared so the emitted `file` struct stays Clone (every emitted struct derives it) and seek /
    // read / write can still take &mut through the mutex
    pub type Handle = Arc<Mutex<tokio::fs::File>>;

    // ---- whole file ----

    pub async fn file_read(path: String) -> String {
        tokio::fs::read_to_string(&path).await.unwrap_or_default()
    }

    pub async fn file_read_bytes(path: String) -> Vec<u8> {
        tokio::fs::read(&path).await.unwrap_or_default()
    }

    pub async fn file_write(path: String, data: String) {
        let _ = tokio::fs::write(&path, data).await;
    }

    pub async fn file_write_bytes(path: String, data: Vec<u8>) {
        let _ = tokio::fs::write(&path, data).await;
    }

    pub async fn file_append(path: String, data: String) {
        if let Ok(mut file) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            let _ = file.write_all(data.as_bytes()).await;
        }
    }

    // `deep` copies a directory tree; without it this is a single file copy, the same split node's `cp` /
    // `copyFile` pair makes
    pub async fn file_copy(from: String, to: String, deep: bool) {
        if deep {
            copy_tree(from.into(), to.into()).await;
        } else {
            let _ = tokio::fs::copy(&from, &to).await;
        }
    }

    // recursion in an async fn needs a boxed future: the future's size would otherwise be infinite
    fn copy_tree(
        from: std::path::PathBuf,
        to: std::path::PathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async move {
            let meta = match tokio::fs::metadata(&from).await {
                Ok(meta) => meta,
                Err(_) => return,
            };

            if !meta.is_dir() {
                let _ = tokio::fs::copy(&from, &to).await;

                return;
            }

            let _ = tokio::fs::create_dir_all(&to).await;
            let mut entries = match tokio::fs::read_dir(&from).await {
                Ok(entries) => entries,
                Err(_) => return,
            };

            while let Ok(Some(entry)) = entries.next_entry().await {
                copy_tree(entry.path(), to.join(entry.file_name())).await;
            }
        })
    }

    pub async fn file_move(from: String, to: String) {
        let _ = tokio::fs::rename(&from, &to).await;
    }

    // `deep` removes a directory tree. Without it a directory is still removed when empty, so `remove` means the
    // same thing on a file and on a directory, the way node's `rm` does.
    pub async fn file_remove(path: String, deep: bool) {
        if deep {
            if tokio::fs::remove_dir_all(&path).await.is_ok() {
                return;
            }

            let _ = tokio::fs::remove_file(&path).await;

            return;
        }

        if tokio::fs::remove_file(&path).await.is_ok() {
            return;
        }

        let _ = tokio::fs::remove_dir(&path).await;
    }

    // an empty `kind` asks only whether the path exists; "file" / "directory" / "link" ask what it is. A link is
    // asked of the link itself (`symlink_metadata`), everything else follows it, which is what node's `stat` /
    // `lstat` split does.
    pub async fn file_test(path: String, kind: String) -> bool {
        if kind == "link" {
            return tokio::fs::symlink_metadata(&path)
                .await
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false);
        }

        let meta = match tokio::fs::metadata(&path).await {
            Ok(meta) => meta,
            Err(_) => return false,
        };

        match kind.as_str() {
            "" => true,
            "file" => meta.is_file(),
            "directory" => meta.is_dir(),
            _ => true,
        }
    }

    // ---- link ----

    pub async fn link_make(from: String, to: String, hard: bool) {
        if hard {
            let _ = tokio::fs::hard_link(&from, &to).await;
        } else {
            let _ = tokio::fs::symlink(&from, &to).await;
        }
    }

    pub async fn link_read(path: String) -> String {
        tokio::fs::read_link(&path)
            .await
            .map(|target| target.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    // ---- permission and owner ----

    pub async fn permission_read(path: String) -> i64 {
        use std::os::unix::fs::PermissionsExt;

        tokio::fs::metadata(&path)
            .await
            .map(|meta| meta.permissions().mode() as i64)
            .unwrap_or(0)
    }

    pub async fn permission_write(path: String, mode: i64) {
        use std::os::unix::fs::PermissionsExt;

        let _ = tokio::fs::set_permissions(
            &path,
            std::fs::Permissions::from_mode(mode as u32),
        )
        .await;
    }

    pub async fn owner_user(path: String) -> i64 {
        use std::os::unix::fs::MetadataExt;

        tokio::fs::metadata(&path)
            .await
            .map(|meta| meta.uid() as i64)
            .unwrap_or(0)
    }

    pub async fn owner_group(path: String) -> i64 {
        use std::os::unix::fs::MetadataExt;

        tokio::fs::metadata(&path)
            .await
            .map(|meta| meta.gid() as i64)
            .unwrap_or(0)
    }

    // tokio has no chown, and std has none either: this is the libc call, which is what every crate that offers
    // one does. A failure is swallowed, like every other write here.
    pub async fn owner_write(path: String, user: i64, group: i64) {
        let path = match std::ffi::CString::new(path) {
            Ok(path) => path,
            Err(_) => return,
        };

        tokio::task::spawn_blocking(move || unsafe {
            libc::chown(path.as_ptr(), user as libc::uid_t, group as libc::gid_t)
        })
        .await
        .ok();
    }

    // ---- temporary ----

    // A unique name under the system temp directory. `kind` is "file" or "directory". No mkdtemp: the name is a
    // uuid, so the collision the racy-name problem is about cannot happen, and the create is exclusive anyway.
    pub async fn temporary_make(
        kind: String,
        prefix: String,
        suffix: String,
    ) -> String {
        let name = format!("{}{}{}", prefix, uuid::Uuid::new_v4(), suffix);
        let path = std::env::temp_dir().join(name);

        if kind == "directory" {
            let _ = tokio::fs::create_dir_all(&path).await;
        } else {
            let _ = tokio::fs::write(&path, "").await;
        }

        path.to_string_lossy().to_string()
    }

    // ---- handle ----

    pub async fn handle_open(
        path: String,
        read: bool,
        write: bool,
        create: bool,
        append: bool,
        clear: bool,
    ) -> Handle {
        let mut options = tokio::fs::OpenOptions::new();
        options.read(read);

        if append {
            options.append(true);
        } else if write {
            options.write(true);
        }

        options.create(create).truncate(clear && !append);

        let file = options.open(&path).await.expect("file handle open");

        Arc::new(Mutex::new(file))
    }

    // tokio closes on drop and has no explicit close; flushing is the observable half of a close, so that is what
    // this does rather than nothing
    pub async fn handle_close(file: Handle) {
        let _ = file.lock().await.flush().await;
    }

    pub async fn handle_read(file: Handle, size: i64) -> String {
        let mut buffer = vec![0u8; size.max(0) as usize];
        let count = file
            .lock()
            .await
            .read(&mut buffer)
            .await
            .unwrap_or(0);

        String::from_utf8_lossy(&buffer[..count]).to_string()
    }

    pub async fn handle_write(file: Handle, data: String) -> i64 {
        let bytes = data.as_bytes();

        match file.lock().await.write_all(bytes).await {
            Ok(()) => bytes.len() as i64,
            Err(_) => 0,
        }
    }

    // `frame` is "start" (absolute), "relative" (from where the cursor is) or "end" (back from the end), the same
    // three SEEK_SET / SEEK_CUR / SEEK_END mean
    pub async fn handle_seek(file: Handle, offset: i64, frame: String) {
        let seek = match frame.as_str() {
            "relative" => std::io::SeekFrom::Current(offset),
            "end" => std::io::SeekFrom::End(-offset),
            _ => std::io::SeekFrom::Start(offset.max(0) as u64),
        };
        let _ = file.lock().await.seek(seek).await;
    }

    pub async fn handle_flush(file: Handle) {
        let _ = file.lock().await.sync_data().await;
    }

    pub async fn handle_clear(file: Handle, size: i64) {
        let _ = file.lock().await.set_len(size.max(0) as u64).await;
    }

    // ---- streams ----

    // A read stream is the open file plus how many bytes of the window are left. `size` 0 means to the end.
    pub type Reader = Arc<Mutex<ReaderState>>;

    pub struct ReaderState {
        pub file: tokio::fs::File,
        pub left: Option<u64>,
    }

    pub async fn reader_open(path: String, start: i64, size: i64) -> Reader {
        let mut file =
            tokio::fs::File::open(&path).await.expect("file reader open");

        if start > 0 {
            let _ = file.seek(std::io::SeekFrom::Start(start as u64)).await;
        }

        Arc::new(Mutex::new(ReaderState {
            file,
            left: if size > 0 { Some(size as u64) } else { None },
        }))
    }

    // the next chunk, or "" at the end of the stream (or the end of the window)
    pub async fn reader_next(stream: Reader) -> String {
        let mut state = stream.lock().await;
        let want = match state.left {
            Some(0) => return String::new(),
            Some(left) => left.min(65536) as usize,
            None => 65536,
        };
        let mut buffer = vec![0u8; want];
        let count = state.file.read(&mut buffer).await.unwrap_or(0);

        if let Some(left) = state.left.as_mut() {
            *left = left.saturating_sub(count as u64);
        }

        String::from_utf8_lossy(&buffer[..count]).to_string()
    }

    pub async fn reader_close(stream: Reader) {
        let _ = stream.lock().await.file.flush().await;
    }

    pub type Writer = Handle;

    pub async fn writer_open(path: String, append: bool) -> Writer {
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&path)
            .await
            .expect("file writer open");

        Arc::new(Mutex::new(file))
    }

    pub async fn writer_push(stream: Writer, data: String) {
        let _ = stream.lock().await.write_all(data.as_bytes()).await;
    }

    pub async fn writer_close(stream: Writer) {
        let _ = stream.lock().await.flush().await;
    }
}
