// List, from Are We Fast Yet, written by hand as plain idiomatic Rust (ours, 2026-10-03): AWFY's own shape, a node
// whose `next` may be none, shared by `Rc` because `tail` hands the same lists to three calls, as the AWFY Rust port's
// memory rules do where C++ shares
use std::rc::Rc;

struct Element {
    #[allow(dead_code)]
    value: i64,
    next: Option<Rc<Element>>,
}

type List = Option<Rc<Element>>;

fn length(list: &List) -> i64 {
    match list {
        None => 0,
        Some(e) => 1 + length(&e.next),
    }
}

fn make_list(size: i64) -> List {
    if size == 0 {
        None
    } else {
        Some(Rc::new(Element { value: size, next: make_list(size - 1) }))
    }
}

fn is_shorter_than(x: &List, y: &List) -> bool {
    let mut x_tail = x;
    let mut y_tail = y;

    while let Some(y_node) = y_tail {
        match x_tail {
            None => return true,
            Some(x_node) => {
                x_tail = &x_node.next;
                y_tail = &y_node.next;
            }
        }
    }

    false
}

fn tail(x: List, y: List, z: List) -> List {
    if is_shorter_than(&y, &x) {
        let a = tail(x.as_ref().unwrap().next.clone(), y.clone(), z.clone());
        let b = tail(y.as_ref().unwrap().next.clone(), z.clone(), x.clone());
        let c = tail(z.as_ref().unwrap().next.clone(), x, y);

        return tail(a, b, c);
    }

    z
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(2);
    let mut total = 0;

    for _ in 0..n {
        total += length(&tail(make_list(15), make_list(10), make_list(6)));
    }

    println!("{}", total);
}
