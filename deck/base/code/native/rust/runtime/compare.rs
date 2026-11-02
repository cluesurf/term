// Deep structural equality over the boxed dynamic (`Rc<dyn Any>`): a value in a box and the value bare read alike
// (an inlined identity leaves the value bare), scalars by value, a number of either width by its value, two boxed lists
// of dynamics element by element, concrete-element lists directly, a JSON array or object by its `serde_json::Value`.
// Anything else is equal only to itself: a type-erased box cannot see further.
mod compare_runtime {
    use std::any::Any;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn as_dyn(v: &dyn Any) -> &dyn Any {
        match v.downcast_ref::<Rc<dyn Any>>() {
            Some(boxed) => boxed.as_ref(),
            None => v,
        }
    }

    // a bare integer literal an inlined identity left behind is an `i32` to rustc until something pins it
    fn number_of(v: &dyn Any) -> Option<f64> {
        if let Some(n) = v.downcast_ref::<i64>() {
            return Some(*n as f64);
        }

        if let Some(n) = v.downcast_ref::<i32>() {
            return Some(*n as f64);
        }

        if let Some(n) = v.downcast_ref::<f64>() {
            return Some(*n);
        }

        None
    }

    fn whole_of(v: &dyn Any) -> Option<i64> {
        if let Some(n) = v.downcast_ref::<i64>() {
            return Some(*n);
        }

        if let Some(n) = v.downcast_ref::<i32>() {
            return Some(*n as i64);
        }

        None
    }

    pub fn deep_equal<A: 'static, B: 'static>(a: A, b: B) -> bool {
        equal_held(as_dyn(&a), as_dyn(&b))
    }

    fn equal_held(a: &dyn Any, b: &dyn Any) -> bool {
        if std::ptr::eq(a as *const dyn Any as *const (), b as *const dyn Any as *const ()) {
            return true;
        }

        if let (Some(x), Some(y)) = (a.downcast_ref::<serde_json::Value>(), b.downcast_ref::<serde_json::Value>()) {
            return x == y;
        }

        if let (Some(x), Some(y)) = (a.downcast_ref::<String>(), b.downcast_ref::<String>()) {
            return x == y;
        }

        if let (Some(x), Some(y)) = (whole_of(a), whole_of(b)) {
            return x == y;
        }

        if let (Some(x), Some(y)) = (number_of(a), number_of(b)) {
            return x == y;
        }

        if let (Some(x), Some(y)) = (a.downcast_ref::<bool>(), b.downcast_ref::<bool>()) {
            return x == y;
        }

        if a.is::<()>() && b.is::<()>() {
            return true;
        }

        if let (Some(x), Some(y)) = (
            a.downcast_ref::<Rc<RefCell<Vec<Rc<dyn Any>>>>>(),
            b.downcast_ref::<Rc<RefCell<Vec<Rc<dyn Any>>>>>(),
        ) {
            let x = x.borrow();
            let y = y.borrow();

            if x.len() != y.len() {
                return false;
            }

            for i in 0..x.len() {
                if !equal_held(as_dyn(x[i].as_ref()), as_dyn(y[i].as_ref())) {
                    return false;
                }
            }

            return true;
        }

        if let (Some(x), Some(y)) = (
            a.downcast_ref::<Rc<RefCell<Vec<i64>>>>(),
            b.downcast_ref::<Rc<RefCell<Vec<i64>>>>(),
        ) {
            return *x.borrow() == *y.borrow();
        }

        if let (Some(x), Some(y)) = (
            a.downcast_ref::<Rc<RefCell<Vec<String>>>>(),
            b.downcast_ref::<Rc<RefCell<Vec<String>>>>(),
        ) {
            return *x.borrow() == *y.borrow();
        }

        false
    }

    fn numeric(v: &dyn Any) -> f64 {
        number_of(v).unwrap_or(f64::NAN)
    }

    pub fn contains(list: Rc<dyn Any>, value: Rc<dyn Any>) -> bool {
        if let Some(items) = list.downcast_ref::<Rc<RefCell<Vec<Rc<dyn Any>>>>>() {
            for item in items.borrow().iter() {
                if equal_held(as_dyn(item.as_ref()), as_dyn(value.as_ref())) {
                    return true;
                }
            }
        }

        false
    }

    pub fn as_text(v: Rc<dyn Any>) -> String {
        v.downcast_ref::<String>().cloned().unwrap_or_default()
    }

    pub fn is_truthy(v: Rc<dyn Any>) -> bool {
        if let Some(b) = v.downcast_ref::<bool>() {
            return *b;
        }

        if let Some(n) = v.downcast_ref::<i64>() {
            return *n != 0;
        }

        if let Some(n) = v.downcast_ref::<f64>() {
            return *n != 0.0;
        }

        if let Some(s) = v.downcast_ref::<String>() {
            return !s.is_empty();
        }

        !v.is::<()>()
    }

    pub fn above(a: Rc<dyn Any>, b: Rc<dyn Any>) -> bool {
        numeric(a.as_ref()) > numeric(b.as_ref())
    }

    pub fn below(a: Rc<dyn Any>, b: Rc<dyn Any>) -> bool {
        numeric(a.as_ref()) < numeric(b.as_ref())
    }

    pub fn gap(a: Rc<dyn Any>, b: Rc<dyn Any>) -> f64 {
        (numeric(a.as_ref()) - numeric(b.as_ref())).abs()
    }
}
