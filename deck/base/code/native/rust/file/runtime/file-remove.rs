// The whole-folder remove of @term/base/file/remove for the rust target, over `std::fs`, never awaiting. It answers a
// list of text, the refusal (refusal.rs: the code name, empty when carried out, the step and the host text) and the
// path the step named, which the public module raises as `failure` worded in Term (term/compiler decision 021 points
// 2, 4 and 1b).
//
// The walk is node's own (fs.rm with recursive and force: its option check's lstat, then rimraf), step for step, so a
// refusal names the step and the path node names: an lstat refused, an unlink, an rmdir, a scandir. ENOENT anywhere is
// no refusal, since nothing is there. An rmdir refused for any reason but ENOTEMPTY, EEXIST or EPERM raises at once,
// so a folder under a read-only parent keeps its entries, as node's does.
//
// Reached only through the public file/remove API.
mod file_remove {
    // runtime-include: refusal.rs

    fn refused_at(failure: &std::io::Error, step: &str, at: &std::path::Path) -> Vec<String> {
        let mut out = refused(failure, step);
        out.push(at.to_string_lossy().into_owned());
        out
    }

    fn gone() -> Vec<String> {
        let mut out = carried();
        out.push(String::new());
        out
    }

    fn is_missing(failure: &std::io::Error) -> bool {
        code_name(failure) == "ENOENT"
    }

    // fs.rm: the path's lstat first (a refusal but ENOENT raised), then the walk with the kind it read
    pub fn remove_path(path: String) -> Vec<String> {
        let at = std::path::PathBuf::from(&path);
        match std::fs::symlink_metadata(&at) {
            Ok(found) => remove_known(&at, found.file_type().is_dir()),
            Err(failure) if is_missing(&failure) => gone(),
            Err(failure) => refused_at(&failure, "lstat", &at),
        }
    }

    // rimraf on one entry under the folder: its lstat refused but for ENOENT, it is unlinked as node unlinks it
    fn remove_entry(at: &std::path::Path) -> Vec<String> {
        match std::fs::symlink_metadata(at) {
            Ok(found) => remove_known(at, found.file_type().is_dir()),
            Err(failure) if is_missing(&failure) => gone(),
            Err(_) => remove_known(at, false),
        }
    }

    // a folder by rmdir, anything else by unlink, and an unlink refused with EISDIR or EPERM tried as a folder, its
    // refusal kept to answer when the rmdir says ENOTDIR
    fn remove_known(at: &std::path::Path, folder: bool) -> Vec<String> {
        if folder {
            return remove_folder(at, None);
        }
        match std::fs::remove_file(at) {
            Ok(_) => gone(),
            Err(failure) if is_missing(&failure) => gone(),
            Err(failure) => {
                let code = code_name(&failure);
                if code == "EISDIR" || code == "EPERM" {
                    remove_folder(at, Some(refused_at(&failure, "unlink", at)))
                } else {
                    refused_at(&failure, "unlink", at)
                }
            }
        }
    }

    fn remove_folder(at: &std::path::Path, original: Option<Vec<String>>) -> Vec<String> {
        match std::fs::remove_dir(at) {
            Ok(_) => gone(),
            Err(failure) if is_missing(&failure) => gone(),
            Err(failure) => {
                let code = code_name(&failure);
                if code == "ENOTEMPTY" || code == "EEXIST" || code == "EPERM" {
                    remove_entries(at)
                } else if code == "ENOTDIR" {
                    original.unwrap_or_else(|| refused_at(&failure, "rmdir", at))
                } else {
                    refused_at(&failure, "rmdir", at)
                }
            }
        }
    }

    // the folder's entries, each removed in turn (the first refusal answered), then the folder's rmdir again
    fn remove_entries(at: &std::path::Path) -> Vec<String> {
        let entries = match std::fs::read_dir(at) {
            Ok(entries) => entries,
            Err(failure) if is_missing(&failure) => return gone(),
            Err(failure) => return refused_at(&failure, "scandir", at),
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(failure) => return refused_at(&failure, "scandir", at),
            };
            let done = remove_entry(&entry.path());
            if !done[0].is_empty() {
                return done;
            }
        }
        match std::fs::remove_dir(at) {
            Ok(_) => gone(),
            Err(failure) if is_missing(&failure) => gone(),
            Err(failure) => refused_at(&failure, "rmdir", at),
        }
    }
}
