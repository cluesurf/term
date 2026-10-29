// Asynchronous filesystem runtime for the rust target: the standard library's blocking `std::fs` calls, each HANDED
// BACK (note/project/term/decision/001-native-work-hands-back-to-the-loop.md). `crate::__term_hand_back` runs the call
// on the runtime's pool of 4 worker threads and the waiting task resumes on the program's one thread when the answer
// comes back, so a read that blocks (a FIFO, a slow disk) stalls no other job. No tokio: a program that reads a file
// builds with plain `rustc`, and tokio::fs was a blocking pool too, one that never ran under Term's executor.
//
// TOTAL, LIKE THE REST OF THE NATIVE SURFACE. std::fs returns `io::Result`; the public file API has no error channel,
// so a failure reads as the empty / false / zero answer here rather than unwinding through emitted code that has no
// way to catch it. The one place that is wrong is a handle op, where a missing file cannot be papered over, and
// `handle_open` says so by panicking on a path it cannot open.
//
// Reached only through the public file API. See note/project/term/stdlib/native-async-file-and-server.md.
mod aio {
    use std::io::{Read, Seek, Write};
    use std::sync::{Arc, Mutex};

    // an open file, shared so the emitted `file` struct stays Clone (every emitted struct derives it) and seek /
    // read / write can still take &mut through the mutex, on whichever worker runs the call
    pub type Handle = Arc<Mutex<std::fs::File>>;

    // ---- whole file ----

    pub async fn file_read(path: String) -> String {
        crate::__term_hand_back(move || std::fs::read_to_string(&path).unwrap_or_default()).await
    }

    pub async fn file_read_bytes(path: String) -> Vec<u8> {
        crate::__term_hand_back(move || std::fs::read(&path).unwrap_or_default()).await
    }

    pub async fn file_write(path: String, data: String) {
        crate::__term_hand_back(move || {
            let _ = std::fs::write(&path, data);
        })
        .await
    }

    pub async fn file_write_bytes(path: String, data: Vec<u8>) {
        crate::__term_hand_back(move || {
            let _ = std::fs::write(&path, data);
        })
        .await
    }

    pub async fn file_append(path: String, data: String) {
        crate::__term_hand_back(move || {
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                let _ = file.write_all(data.as_bytes());
            }
        })
        .await
    }

    // `deep` copies a directory tree; without it this is a single file copy, the same split node's `cp` /
    // `copyFile` pair makes
    pub async fn file_copy(from: String, to: String, deep: bool) {
        crate::__term_hand_back(move || {
            if deep {
                copy_tree(from.into(), to.into());
            } else {
                let _ = std::fs::copy(&from, &to);
            }
        })
        .await
    }

    fn copy_tree(from: std::path::PathBuf, to: std::path::PathBuf) {
        let meta = match std::fs::metadata(&from) {
            Ok(meta) => meta,
            Err(_) => return,
        };

        if !meta.is_dir() {
            let _ = std::fs::copy(&from, &to);

            return;
        }

        let _ = std::fs::create_dir_all(&to);
        let entries = match std::fs::read_dir(&from) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            copy_tree(entry.path(), to.join(entry.file_name()));
        }
    }

    pub async fn file_move(from: String, to: String) {
        crate::__term_hand_back(move || {
            let _ = std::fs::rename(&from, &to);
        })
        .await
    }

    // `deep` removes a directory tree. Without it a directory is still removed when empty, so `remove` means the
    // same thing on a file and on a directory, the way node's `rm` does.
    pub async fn file_remove(path: String, deep: bool) {
        crate::__term_hand_back(move || {
            if deep {
                if std::fs::remove_dir_all(&path).is_ok() {
                    return;
                }

                let _ = std::fs::remove_file(&path);

                return;
            }

            if std::fs::remove_file(&path).is_ok() {
                return;
            }

            let _ = std::fs::remove_dir(&path);
        })
        .await
    }

    // an empty `kind` asks only whether the path exists; "file" / "directory" / "link" ask what it is. A link is
    // asked of the link itself (`symlink_metadata`), everything else follows it, which is what node's `stat` /
    // `lstat` split does.
    pub async fn file_test(path: String, kind: String) -> bool {
        crate::__term_hand_back(move || {
            if kind == "link" {
                return std::fs::symlink_metadata(&path)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false);
            }

            let meta = match std::fs::metadata(&path) {
                Ok(meta) => meta,
                Err(_) => return false,
            };

            match kind.as_str() {
                "" => true,
                "file" => meta.is_file(),
                "directory" => meta.is_dir(),
                _ => true,
            }
        })
        .await
    }

    // ---- link ----

    pub async fn link_make(from: String, to: String, hard: bool) {
        crate::__term_hand_back(move || {
            if hard {
                let _ = std::fs::hard_link(&from, &to);
            } else {
                let _ = std::os::unix::fs::symlink(&from, &to);
            }
        })
        .await
    }

    pub async fn link_read(path: String) -> String {
        crate::__term_hand_back(move || {
            std::fs::read_link(&path)
                .map(|target| target.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .await
    }

    // ---- permission and owner ----

    pub async fn permission_read(path: String) -> i64 {
        use std::os::unix::fs::PermissionsExt;

        crate::__term_hand_back(move || {
            std::fs::metadata(&path)
                .map(|meta| meta.permissions().mode() as i64)
                .unwrap_or(0)
        })
        .await
    }

    pub async fn permission_write(path: String, mode: i64) {
        use std::os::unix::fs::PermissionsExt;

        crate::__term_hand_back(move || {
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode as u32));
        })
        .await
    }

    pub async fn owner_user(path: String) -> i64 {
        use std::os::unix::fs::MetadataExt;

        crate::__term_hand_back(move || std::fs::metadata(&path).map(|meta| meta.uid() as i64).unwrap_or(0)).await
    }

    pub async fn owner_group(path: String) -> i64 {
        use std::os::unix::fs::MetadataExt;

        crate::__term_hand_back(move || std::fs::metadata(&path).map(|meta| meta.gid() as i64).unwrap_or(0)).await
    }

    // std has no chown: this is the libc call, which is what every crate that offers one does. A failure is
    // swallowed, like every other write here.
    pub async fn owner_write(path: String, user: i64, group: i64) {
        let path = match std::ffi::CString::new(path) {
            Ok(path) => path,
            Err(_) => return,
        };

        crate::__term_hand_back(move || unsafe {
            libc::chown(path.as_ptr(), user as libc::uid_t, group as libc::gid_t);
        })
        .await
    }

    // ---- temporary ----

    // A unique name under the system temp directory. `kind` is "file" or "directory". No mkdtemp: the name is a
    // uuid, so the collision the racy-name problem is about cannot happen, and the create is exclusive anyway.
    pub async fn temporary_make(kind: String, prefix: String, suffix: String) -> String {
        let name = format!("{}{}{}", prefix, uuid::Uuid::new_v4(), suffix);
        let path = std::env::temp_dir().join(name);

        crate::__term_hand_back(move || {
            if kind == "directory" {
                let _ = std::fs::create_dir_all(&path);
            } else {
                let _ = std::fs::write(&path, "");
            }

            path.to_string_lossy().to_string()
        })
        .await
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
        let mut options = std::fs::OpenOptions::new();
        options.read(read);

        if append {
            options.append(true);
        } else if write {
            options.write(true);
        }

        options.create(create).truncate(clear && !append);

        let file = crate::__term_hand_back(move || options.open(&path)).await.expect("file handle open");

        Arc::new(Mutex::new(file))
    }

    // std closes on drop and has no explicit close; flushing is the observable half of a close, so that is what
    // this does rather than nothing
    pub async fn handle_close(file: Handle) {
        crate::__term_hand_back(move || {
            if let Ok(mut held) = file.lock() {
                let _ = held.flush();
            }
        })
        .await
    }

    pub async fn handle_read(file: Handle, size: i64) -> String {
        crate::__term_hand_back(move || {
            let mut buffer = vec![0u8; size.max(0) as usize];
            let count = file.lock().map(|mut held| held.read(&mut buffer).unwrap_or(0)).unwrap_or(0);

            String::from_utf8_lossy(&buffer[..count]).to_string()
        })
        .await
    }

    pub async fn handle_write(file: Handle, data: String) -> i64 {
        crate::__term_hand_back(move || {
            let bytes = data.as_bytes();

            match file.lock().map(|mut held| held.write_all(bytes)) {
                Ok(Ok(())) => bytes.len() as i64,
                _ => 0,
            }
        })
        .await
    }

    // `frame` is "start" (absolute), "relative" (from where the cursor is) or "end" (back from the end), the same
    // three SEEK_SET / SEEK_CUR / SEEK_END mean
    pub async fn handle_seek(file: Handle, offset: i64, frame: String) {
        let seek = match frame.as_str() {
            "relative" => std::io::SeekFrom::Current(offset),
            "end" => std::io::SeekFrom::End(-offset),
            _ => std::io::SeekFrom::Start(offset.max(0) as u64),
        };

        crate::__term_hand_back(move || {
            if let Ok(mut held) = file.lock() {
                let _ = held.seek(seek);
            }
        })
        .await
    }

    pub async fn handle_flush(file: Handle) {
        crate::__term_hand_back(move || {
            if let Ok(held) = file.lock() {
                let _ = held.sync_data();
            }
        })
        .await
    }

    pub async fn handle_clear(file: Handle, size: i64) {
        crate::__term_hand_back(move || {
            if let Ok(held) = file.lock() {
                let _ = held.set_len(size.max(0) as u64);
            }
        })
        .await
    }

    // ---- streams ----

    // A read stream is the open file plus how many bytes of the window are left. `size` 0 means to the end. `tail` holds
    // the bytes of a character a chunk boundary split, until the next chunk completes it (decision 067 section 3,
    // term-self-host-001-0380).
    pub type Reader = Arc<Mutex<ReaderState>>;

    pub struct ReaderState {
        pub file: std::fs::File,
        pub left: Option<u64>,
        pub tail: Vec<u8>,
    }

    // how many trailing bytes begin a character the bytes do not complete: 0 to 3
    fn incomplete_tail(bytes: &[u8]) -> usize {
        for back in 1..=bytes.len().min(3) {
            let byte = bytes[bytes.len() - back];

            if byte & 0xC0 == 0x80 {
                continue;
            }

            let need = if byte >= 0xF0 { 4 } else if byte >= 0xE0 { 3 } else if byte >= 0xC0 { 2 } else { 1 };

            return if need > back { back } else { 0 };
        }

        0
    }

    pub async fn reader_open(path: String, start: i64, size: i64) -> Reader {
        let file = crate::__term_hand_back(move || {
            std::fs::File::open(&path).map(|mut file| {
                if start > 0 {
                    let _ = file.seek(std::io::SeekFrom::Start(start as u64));
                }

                file
            })
        })
        .await
        .expect("file reader open");

        Arc::new(Mutex::new(ReaderState {
            file,
            left: if size > 0 { Some(size as u64) } else { None },
            tail: Vec::new(),
        }))
    }

    // the next chunk, or "" at the end of the stream (or the end of the window). A chunk ends before an incomplete
    // character, held in `tail` for the next one; at the end the held bytes are flushed (as U+FFFD, being incomplete).
    // A chunk that decoded to nothing while bytes were read reads on, so "" only ever means the end
    pub async fn reader_next(stream: Reader) -> String {
        crate::__term_hand_back(move || {
            let mut state = match stream.lock() {
                Ok(state) => state,
                Err(_) => return String::new(),
            };

            loop {
                let want = match state.left {
                    Some(0) => 0,
                    Some(left) => left.min(65536) as usize,
                    None => 65536,
                };
                let mut buffer = vec![0u8; want];
                let count = if want == 0 { 0 } else { state.file.read(&mut buffer).unwrap_or(0) };

                if count == 0 {
                    let rest = std::mem::take(&mut state.tail);

                    return String::from_utf8_lossy(&rest).to_string();
                }

                if let Some(left) = state.left.as_mut() {
                    *left = left.saturating_sub(count as u64);
                }

                let mut bytes = std::mem::take(&mut state.tail);
                bytes.extend_from_slice(&buffer[..count]);
                let keep = bytes.len() - incomplete_tail(&bytes);
                state.tail = bytes.split_off(keep);

                if !bytes.is_empty() {
                    return String::from_utf8_lossy(&bytes).to_string();
                }
            }
        })
        .await
    }

    pub async fn reader_close(stream: Reader) {
        crate::__term_hand_back(move || {
            if let Ok(mut state) = stream.lock() {
                let _ = state.file.flush();
            }
        })
        .await
    }

    pub type Writer = Handle;

    pub async fn writer_open(path: String, append: bool) -> Writer {
        let file = crate::__term_hand_back(move || {
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(append)
                .truncate(!append)
                .open(&path)
        })
        .await
        .expect("file writer open");

        Arc::new(Mutex::new(file))
    }

    pub async fn writer_push(stream: Writer, data: String) {
        crate::__term_hand_back(move || {
            if let Ok(mut held) = stream.lock() {
                let _ = held.write_all(data.as_bytes());
            }
        })
        .await
    }

    pub async fn writer_close(stream: Writer) {
        crate::__term_hand_back(move || {
            if let Ok(mut held) = stream.lock() {
                let _ = held.flush();
            }
        })
        .await
    }
}
