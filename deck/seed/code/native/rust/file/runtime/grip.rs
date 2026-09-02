// Synchronous file handles for the rust target, over `std::fs::File`. The asynchronous side is tokio; this is the
// same operations with nothing to await, for the places that cannot wait (reading configuration before a runtime
// is up) or should not (a small read where a task switch costs more than the read).
//
// Reached only through the public file/synchronous API.
mod grip {
    use std::cell::RefCell;
    use std::io::{Read, Seek, Write};
    use std::rc::Rc;

    // Rc so the emitted `synchronous-file` record stays Clone (every emitted struct derives it), RefCell because
    // read, write and seek all take &mut. Two copies of the record are two views of ONE open file, which is what
    // a cursor has to mean.
    pub type Grip = Rc<RefCell<std::fs::File>>;

    pub fn grip_open(
        path: String,
        read: bool,
        write: bool,
        create: bool,
        append: bool,
        clear: bool,
    ) -> Grip {
        let mut options = std::fs::OpenOptions::new();
        options.read(read);

        if append {
            options.append(true);
        } else if write {
            options.write(true);
        }

        options.create(create).truncate(clear && !append);

        Rc::new(RefCell::new(
            options.open(&path).expect("synchronous file open"),
        ))
    }

    // std closes on drop and has no explicit close; flushing is the observable half of one
    pub fn grip_close(file: Grip) {
        let _ = file.borrow_mut().flush();
    }

    pub fn grip_read(file: Grip, size: i64) -> String {
        let mut buffer = vec![0u8; size.max(0) as usize];
        let count = file.borrow_mut().read(&mut buffer).unwrap_or(0);

        String::from_utf8_lossy(&buffer[..count]).to_string()
    }

    pub fn grip_write(file: Grip, data: String) -> i64 {
        let bytes = data.as_bytes();

        match file.borrow_mut().write_all(bytes) {
            Ok(()) => bytes.len() as i64,
            Err(_) => 0,
        }
    }

    pub fn grip_seek(file: Grip, offset: i64, frame: String) {
        let seek = match frame.as_str() {
            "relative" => std::io::SeekFrom::Current(offset),
            "end" => std::io::SeekFrom::End(-offset),
            _ => std::io::SeekFrom::Start(offset.max(0) as u64),
        };
        let _ = file.borrow_mut().seek(seek);
    }

    pub fn grip_flush(file: Grip) {
        let _ = file.borrow_mut().sync_data();
    }

    pub fn grip_clear(file: Grip, size: i64) {
        let _ = file.borrow_mut().set_len(size.max(0) as u64);
    }
}
