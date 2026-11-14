// The two raising disk calls of @term/base/file/create for the rust target, over `std::fs`, never awaiting. Each answers
// a list of text, the refusal (refusal.rs: the code name, empty when carried out, the step and the host text), which
// the public module raises as `failure` worded in Term (term/compiler decision 021 points 2, 4 and 1b).
//
// Reached only through the public file/create API.
mod file_create {
    // runtime-include: refusal.rs

    // mkdir(2) of the folder and of every missing folder above it, as node's recursive mkdirSync: a folder already
    // there is carried out, anything else at the path (a file) is EEXIST, and a file above it is ENOTDIR. Node names
    // the path given whichever folder of the chain refused, so the step alone crosses
    pub fn make_folder_path(path: String) -> Vec<String> {
        match std::fs::create_dir_all(&path) {
            Ok(_) => carried(),
            Err(failure) => refused(&failure, "mkdir"),
        }
    }

    // open(2) with O_CREAT and O_EXCL (node's `wx`) is the `open` step, mode 0666 before the umask as node's, and the
    // writes the `write` step
    pub fn write_new_path(path: String, body: String) -> Vec<String> {
        use std::io::Write;

        let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(failure) => return refused(&failure, "open"),
        };

        match file.write_all(body.as_bytes()) {
            Ok(_) => carried(),
            Err(failure) => refused(&failure, "write"),
        }
    }
}
