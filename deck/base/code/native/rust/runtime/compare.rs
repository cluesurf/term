// Deep structural equality over the boxed dynamic (`Rc<dyn Any>`): identical scalars are equal, two boxed
// lists of dynamics are equal when their sizes match and every element pair is deep-equal, concrete-element
// lists compare directly, and anything else answers false (a type-erased box cannot see further).
mod compare_runtime {
    use std::any::Any;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn scalar_equal(a: &dyn Any, b: &dyn Any) -> Option<bool> {
        if let (Some(x), Some(y)) = (a.downcast_ref::<String>(), b.downcast_ref::<String>()) {
            return Some(x == y);
        }

        if let (Some(x), Some(y)) = (a.downcast_ref::<i64>(), b.downcast_ref::<i64>()) {
            return Some(x == y);
        }

        if let (Some(x), Some(y)) = (a.downcast_ref::<f64>(), b.downcast_ref::<f64>()) {
            return Some(x == y);
        }

        if let (Some(x), Some(y)) = (a.downcast_ref::<bool>(), b.downcast_ref::<bool>()) {
            return Some(x == y);
        }

        if a.is::<()>() && b.is::<()>() {
            return Some(true);
        }

        None
    }

    fn as_dyn(v: &dyn Any) -> &dyn Any {
        match v.downcast_ref::<Rc<dyn Any>>() {
            Some(boxed) => boxed.as_ref(),
            None => v,
        }
    }

    pub fn deep_equal<A: 'static, B: 'static>(a: A, b: B) -> bool {
        let a: &dyn Any = as_dyn(&a);
        let b: &dyn Any = as_dyn(&b);

        if let (Some(x), Some(y)) = (
            a.downcast_ref::<serde_json::Value>(),
            b.downcast_ref::<serde_json::Value>(),
        ) {
            return x == y;
        }

        deep_equal_dyn(boxed_of(a), boxed_of(b))
    }

    fn boxed_of(v: &dyn Any) -> Rc<dyn Any> {
        if let Some(s) = v.downcast_ref::<String>() {
            return Rc::new(s.clone());
        }

        if let Some(n) = v.downcast_ref::<i64>() {
            return Rc::new(*n);
        }

        if let Some(n) = v.downcast_ref::<f64>() {
            return Rc::new(*n);
        }

        if let Some(b) = v.downcast_ref::<bool>() {
            return Rc::new(*b);
        }

        if let Some(json) = v.downcast_ref::<serde_json::Value>() {
            return Rc::new(json.clone());
        }

        if let Some(l) = v.downcast_ref::<Rc<RefCell<Vec<Rc<dyn Any>>>>>() {
            return Rc::new(l.clone());
        }

        if let Some(l) = v.downcast_ref::<Rc<RefCell<Vec<i64>>>>() {
            return Rc::new(l.clone());
        }

        if let Some(l) = v.downcast_ref::<Rc<RefCell<Vec<String>>>>() {
            return Rc::new(l.clone());
        }

        Rc::new(())
    }

    fn deep_equal_dyn(a: Rc<dyn Any>, b: Rc<dyn Any>) -> bool {
        if let (Some(x), Some(y)) = (
            a.downcast_ref::<serde_json::Value>(),
            b.downcast_ref::<serde_json::Value>(),
        ) {
            return x == y;
        }

        if let Some(answer) = scalar_equal(a.as_ref(), b.as_ref()) {
            return answer;
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
                if !deep_equal_dyn(x[i].clone(), y[i].clone()) {
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
        if let Some(n) = v.downcast_ref::<i64>() {
            return *n as f64;
        }

        if let Some(n) = v.downcast_ref::<f64>() {
            return *n;
        }

        f64::NAN
    }

    pub fn contains(list: Rc<dyn Any>, value: Rc<dyn Any>) -> bool {
        if let Some(items) = list.downcast_ref::<Rc<RefCell<Vec<Rc<dyn Any>>>>>() {
            for item in items.borrow().iter() {
                if deep_equal_dyn(item.clone(), value.clone()) {
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
