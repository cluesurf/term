// Whole-path file calls for the rust target that never await, over `std::fs`. `stat_path` builds the emitted `StatRaw`
// record directly (the shim is prepended to the module that declares it, so the type is in scope through `use
// super::*`), one call. `changed` is seconds times 1000 plus nanoseconds over 1e6 in a double, the arithmetic node's
// `mtimeMs` is.
//
// `read_path` and `list_path` answer a list of text, the refusal first (refusal.rs: the code name, empty when carried
// out, the step and the host text), then the text, or each entry's name and kind. The public module raises the refusal
// as `failure` worded in Term (term/compiler decision 021 points 2 and 4). Every other call here stays total.
//
// Reached only through the public file/blocking API, which has already ruled out a missing path.
mod blocking {
    use super::StatRaw;

    // runtime-include: refusal.rs

    // milliseconds from the epoch with the fraction kept, signed: on unix the same double `mtime * 1000 +
    // mtime_nsec / 1e6` makes, and read through `SystemTime` so it is one call on every system
    fn moment(time: std::io::Result<std::time::SystemTime>) -> f64 {
        let at = match time {
            Ok(at) => at,
            Err(_) => return 0.0,
        };

        // before the epoch, unix keeps seconds floored and nanoseconds forward of them: -1.5 s is -2 and 5e8
        let (seconds, nanoseconds) = match at.duration_since(std::time::UNIX_EPOCH) {
            Ok(since) => (since.as_secs() as i64, since.subsec_nanos() as i64),
            Err(before) => {
                let back = before.duration();

                match back.subsec_nanos() {
                    0 => (-(back.as_secs() as i64), 0),
                    nanos => (-(back.as_secs() as i64) - 1, 1_000_000_000 - nanos as i64),
                }
            }
        };

        seconds as f64 * 1000.0 + nanoseconds as f64 / 1e6
    }

    // open(2) is the `open` step and the reads the `read` step, as node's readFileSync names them: a folder opens and
    // its read is refused
    pub fn read_path(path: String) -> Vec<String> {
        use std::io::Read;

        let mut file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(failure) => return refused(&failure, "open"),
        };

        let mut bytes = Vec::new();

        match file.read_to_end(&mut bytes) {
            Ok(_) => {
                let mut out = carried();
                out.push(String::from_utf8_lossy(&bytes).to_string());
                out
            }
            Err(failure) => refused(&failure, "read"),
        }
    }

    // a symbolic link is followed, so a link to nothing is not there
    pub fn exists_path(path: String) -> bool {
        std::path::Path::new(&path).exists()
    }

    pub fn stat_path(path: String) -> StatRaw {
        match std::fs::metadata(&path) {
            Ok(meta) => StatRaw {
                kind: if meta.is_dir() {
                    "directory".to_string()
                } else if meta.is_file() {
                    "file".to_string()
                } else {
                    "other".to_string()
                },
                size: meta.len() as i64,
                changed: moment(meta.modified()),
            },
            Err(_) => StatRaw {
                kind: "other".to_string(),
                size: 0,
                changed: 0.0,
            },
        }
    }

    // the platform's own order, no `.` or `..`, each kind the entry's own with links not followed. The opening and
    // every read of the folder are the `scandir` step, as node's readdirSync names them
    pub fn list_path(path: String) -> Vec<String> {
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(failure) => return refused(&failure, "scandir"),
        };

        let mut out = carried();

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(failure) => return refused(&failure, "scandir"),
            };

            let kind = match entry.file_type() {
                Ok(kind) if kind.is_dir() => "directory",
                Ok(kind) if kind.is_symlink() => "link",
                Ok(kind) if kind.is_file() => "file",
                _ => "other",
            };

            out.push(entry.file_name().to_string_lossy().to_string());
            out.push(kind.to_string());
        }

        out
    }

    pub fn real_path(path: String) -> String {
        match std::fs::canonicalize(&path) {
            Ok(real) => real.to_string_lossy().to_string(),
            Err(_) => path,
        }
    }

    // the path's own kind, links not followed (lstat), or "" when not even a link is there
    pub fn kind_path(path: String) -> String {
        match std::fs::symlink_metadata(&path) {
            Ok(meta) => {
                let kind = meta.file_type();

                if kind.is_symlink() {
                    "link".to_string()
                } else if kind.is_dir() {
                    "directory".to_string()
                } else if kind.is_file() {
                    "file".to_string()
                } else {
                    "other".to_string()
                }
            }
            Err(_) => String::new(),
        }
    }

    // rename(2): a file or an empty folder at `to` is replaced, as node's renameSync
    pub fn rename_path(from: String, to: String) -> bool {
        std::fs::rename(&from, &to).is_ok()
    }

    // rmdir(2), never recursive: a folder that holds anything, or a path that is not a folder, is refused
    pub fn remove_folder_path(path: String) -> bool {
        std::fs::remove_dir(&path).is_ok()
    }

    // a symbolic link with the target written as given. Windows has no junction in std, so it is a folder link there,
    // which needs the privilege a junction does not
    pub fn link_path(target: String, at: String) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &at).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(&target, &at).is_ok()
        }
    }

    // the whole text as UTF-8, the file made or cut, as node's writeFileSync
    pub fn write_path(path: String, body: String) -> bool {
        std::fs::write(&path, body.as_bytes()).is_ok()
    }
}
