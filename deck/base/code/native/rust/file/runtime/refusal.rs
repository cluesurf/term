    // ---- the refusal of a file call (term/compiler decision 021 points 4 and 4a) ----
    //
    // Included whole by aio.rs and blocking.rs (`// runtime-include: refusal.rs`), so each of the two modules holds its
    // own copy of this one source. A refused std::fs call crosses as a list of text: its POSIX code name, the step that
    // failed as node's `syscall` names it, and the host's own text. A call carried out answers the empty code name.
    // Term words the note (@term/base/file/failure), never this file, and no record crosses: about 25 modules dock aio.

    // the POSIX code name of an OS error number: the numbers every unix shares, and the three that differ between
    // Linux and the rest (ENAMETOOLONG, ELOOP, ENOTEMPTY). Any other number, or a host with no POSIX numbers (Windows),
    // answers `?`, which no table row names, so the note is then the host's own text
    #[allow(dead_code)]
    fn code_name(failure: &std::io::Error) -> String {
        if !cfg!(unix) {
            return "?".to_string();
        }

        let linux = cfg!(target_os = "linux");
        let name = match failure.raw_os_error() {
            Some(1) => "EPERM",
            Some(2) => "ENOENT",
            Some(5) => "EIO",
            Some(13) => "EACCES",
            Some(17) => "EEXIST",
            Some(20) => "ENOTDIR",
            Some(21) => "EISDIR",
            Some(28) => "ENOSPC",
            Some(30) => "EROFS",
            Some(31) => "EMLINK",
            Some(number) if number == (if linux { 36 } else { 63 }) => "ENAMETOOLONG",
            Some(number) if number == (if linux { 40 } else { 62 }) => "ELOOP",
            Some(number) if number == (if linux { 39 } else { 66 }) => "ENOTEMPTY",
            _ => "?",
        };

        name.to_string()
    }

    #[allow(dead_code)]
    fn refused(failure: &std::io::Error, step: &str) -> Vec<String> {
        vec![code_name(failure), step.to_string(), failure.to_string()]
    }

    #[allow(dead_code)]
    fn carried() -> Vec<String> {
        vec![String::new(), String::new(), String::new()]
    }
