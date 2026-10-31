// File metadata for the rust target, over `std::fs::metadata` handed back to the program's loop
// (`crate::__term_hand_back`, decision 001). It builds the emitted `FileMetadata` record directly (the shim is
// prepended to the module that declares it, so the type is in scope through `use super::*`), which is what keeps one
// `stat` call from becoming seven. Reached only through the public file/metadata API.
mod stat {
    use super::FileMetadata;

    // milliseconds since the epoch, the unit every backend's metadata reports, and 0 for a filesystem that does
    // not record the field (birth time on most Linux filesystems)
    fn moment(time: std::io::Result<std::time::SystemTime>) -> i64 {
        time.ok()
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0)
    }

    // whole seconds from the epoch, floored, times 1000: what unix's `mtime() * 1000` reads, through `SystemTime` so
    // it is one call on every system
    fn whole_moment(time: std::io::Result<std::time::SystemTime>) -> i64 {
        let at = match time {
            Ok(at) => at,
            Err(_) => return 0,
        };

        let seconds = match at.duration_since(std::time::UNIX_EPOCH) {
            Ok(since) => since.as_secs() as i64,
            Err(before) => {
                let back = before.duration();

                -(back.as_secs() as i64) - if back.subsec_nanos() > 0 { 1 } else { 0 }
            }
        };

        seconds * 1000
    }

    #[cfg(unix)]
    fn mode_of(meta: &std::fs::Metadata) -> i64 {
        use std::os::unix::fs::PermissionsExt;

        meta.permissions().mode() as i64
    }

    // Windows has no mode, only a read-only flag. This is the mode libuv (so node) makes of it: the kind
    // (link 0o120000, directory 0o040000, else file 0o100000), then 0o444 when read-only and 0o666 when not.
    // The same as aio.rs `mode_of`: each shim is prepended to its own module, so neither can reach the other's.
    #[cfg(windows)]
    fn mode_of(meta: &std::fs::Metadata) -> i64 {
        let kind = if meta.file_type().is_symlink() {
            0o120000
        } else if meta.is_dir() {
            0o040000
        } else {
            0o100000
        };

        kind | if meta.permissions().readonly() { 0o444 } else { 0o666 }
    }

    pub async fn meta_read(path: String, follow: bool) -> FileMetadata {
        crate::__term_hand_back(move || meta_of(path, follow)).await
    }

    fn meta_of(path: String, follow: bool) -> FileMetadata {
        let meta = if follow {
            std::fs::metadata(&path)
        } else {
            std::fs::symlink_metadata(&path)
        };

        let meta = match meta {
            Ok(meta) => meta,
            // a missing path reads as the zero record rather than unwinding: the public API is total
            Err(_) => {
                return FileMetadata {
                    size: 0,
                    kind: "other".to_string(),
                    made: 0,
                    changed: 0,
                    opened: 0,
                    mode: 0,
                    link: false,
                }
            }
        };

        let kind = if meta.is_dir() {
            "directory"
        } else if meta.file_type().is_symlink() {
            "link"
        } else if meta.is_file() {
            "file"
        } else {
            "other"
        };

        FileMetadata {
            size: meta.len() as i64,
            kind: kind.to_string(),
            made: moment(meta.created()),
            changed: whole_moment(meta.modified()),
            opened: whole_moment(meta.accessed()),
            mode: mode_of(&meta),
            link: meta.file_type().is_symlink(),
        }
    }
}
