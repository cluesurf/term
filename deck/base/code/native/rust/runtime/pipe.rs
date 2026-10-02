// Pipe runtime: stream one child's stdout into another child's stdin until the source closes.
// Each dock handle carries the platform process as Rc<RefCell<std::process::Child>>; a handle of
// the wrong shape is a no-op. Reached only through the public process API.
mod pipe_runtime {
    use std::io::{Read, Write};

    fn of(dock: &std::rc::Rc<dyn std::any::Any>) -> Option<&std::cell::RefCell<std::process::Child>> {
        dock.downcast_ref::<std::cell::RefCell<std::process::Child>>()
    }

    pub async fn connect(from: std::rc::Rc<dyn std::any::Any>, to: std::rc::Rc<dyn std::any::Any>) {
        let stdout = of(&from).and_then(|cell| cell.borrow_mut().stdout.take());
        let stdin = of(&to).and_then(|cell| cell.borrow_mut().stdin.take());
        if let (Some(mut stdout), Some(mut stdin)) = (stdout, stdin) {
            let mut buf = [0u8; 8192];
            loop {
                let n = match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if stdin.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
}
