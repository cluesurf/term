// Child process runtime. The child record's opaque dock handle carries the platform process as
// Rc<RefCell<std::process::Child>>; each accessor downcasts and borrows it. A handle of the wrong
// shape reads as an already-finished process rather than crashing. Reached only through the public
// process API.
mod child_runtime {
    use std::io::{Read, Write};

    fn of(dock: &std::rc::Rc<dyn std::any::Any>) -> Option<&std::cell::RefCell<std::process::Child>> {
        dock.downcast_ref::<std::cell::RefCell<std::process::Child>>()
    }

    pub fn wait(dock: std::rc::Rc<dyn std::any::Any>) -> i64 {
        match of(&dock) {
            Some(cell) => cell
                .borrow_mut()
                .wait()
                .ok()
                .and_then(|status| status.code())
                .unwrap_or(-1) as i64,
            None => -1,
        }
    }

    pub fn stop(dock: std::rc::Rc<dyn std::any::Any>) {
        if let Some(cell) = of(&dock) {
            let id = cell.borrow().id() as i32;
            unsafe {
                libc::kill(id, libc::SIGTERM);
            }
        }
    }

    pub fn kill(dock: std::rc::Rc<dyn std::any::Any>) {
        if let Some(cell) = of(&dock) {
            let _ = cell.borrow_mut().kill();
        }
    }

    pub fn write(dock: std::rc::Rc<dyn std::any::Any>, data: String) {
        if let Some(cell) = of(&dock) {
            if let Some(stdin) = cell.borrow_mut().stdin.as_mut() {
                let _ = stdin.write_all(data.as_bytes());
            }
        }
    }

    pub fn close(dock: std::rc::Rc<dyn std::any::Any>) {
        if let Some(cell) = of(&dock) {
            drop(cell.borrow_mut().stdin.take());
        }
    }

    pub fn read_out(dock: std::rc::Rc<dyn std::any::Any>) -> String {
        let mut buf = String::new();
        if let Some(cell) = of(&dock) {
            if let Some(stdout) = cell.borrow_mut().stdout.as_mut() {
                let _ = stdout.read_to_string(&mut buf);
            }
        }
        buf
    }

    pub fn read_error(dock: std::rc::Rc<dyn std::any::Any>) -> String {
        let mut buf = String::new();
        if let Some(cell) = of(&dock) {
            if let Some(stderr) = cell.borrow_mut().stderr.as_mut() {
                let _ = stderr.read_to_string(&mut buf);
            }
        }
        buf
    }
}
