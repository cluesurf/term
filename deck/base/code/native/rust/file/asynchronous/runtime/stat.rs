// File metadata for the rust target, over `std::fs::metadata` handed back to the program's loop
// (`crate::__term_hand_back`, decision 001). It builds the emitted `FileMetadata` record directly (the shim is
// prepended to the module that declares it, so the type is in scope through `use super::*`), which is what keeps one
// `stat` call from becoming seven. Reached only through the public file/metadata API.
mod stat {
    use super::FileMetadata;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;

    // milliseconds since the epoch, the unit every backend's metadata reports, and 0 for a filesystem that does
    // not record the field (birth time on most Linux filesystems)
    fn moment(time: std::io::Result<std::time::SystemTime>) -> i64 {
        time.ok()
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0)
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
            changed: meta.mtime() * 1000,
            opened: meta.atime() * 1000,
            mode: meta.permissions().mode() as i64,
            link: meta.file_type().is_symlink(),
        }
    }
}
