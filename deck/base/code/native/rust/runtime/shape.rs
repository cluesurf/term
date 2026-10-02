// Runtime shape checks. Rust erases types at compile time, so each check is generic over whatever the call
// site actually holds: a concrete value (i64, String, a Vec handle) answers from its own type, and a boxed
// dynamic (`Rc<dyn Any>`, the backend's `unknown`) is unwrapped first and answered from its contents. A list
// of an element outside the boxed currencies answers `is_list` false, which is the honest limit of a
// type-erased box.
mod shape {
    use std::any::Any;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    fn inner(value: &dyn Any) -> &dyn Any {
        match value.downcast_ref::<Rc<dyn Any>>() {
            Some(boxed) => boxed.as_ref(),
            None => value,
        }
    }

    pub fn is_void<T: 'static>(value: T) -> bool {
        inner(&value).is::<()>()
    }

    pub fn is_null<T: 'static>(value: T) -> bool {
        inner(&value).is::<()>()
    }

    pub fn is_present<T: 'static>(value: T) -> bool {
        !inner(&value).is::<()>()
    }

    pub fn is_text<T: 'static>(value: T) -> bool {
        inner(&value).is::<String>()
    }

    pub fn is_number<T: 'static>(value: T) -> bool {
        let v = inner(&value);

        v.is::<i64>() || v.is::<f64>()
    }

    pub fn is_flag<T: 'static>(value: T) -> bool {
        inner(&value).is::<bool>()
    }

    pub fn is_list<T: 'static>(value: T) -> bool {
        let v = inner(&value);

        v.is::<Rc<RefCell<Vec<Rc<dyn Any>>>>>()
            || v.is::<Rc<RefCell<Vec<String>>>>()
            || v.is::<Rc<RefCell<Vec<i64>>>>()
            || v.is::<Rc<RefCell<Vec<f64>>>>()
            || v.is::<Rc<RefCell<Vec<bool>>>>()
    }

    pub fn is_hash<T: 'static>(value: T) -> bool {
        let v = inner(&value);

        v.is::<Rc<RefCell<HashMap<String, Rc<dyn Any>>>>>()
            || v.is::<Rc<RefCell<HashMap<String, String>>>>()
            || v.is::<Rc<RefCell<HashMap<String, i64>>>>()
    }

    pub fn type_of<T: 'static>(value: T) -> String {
        let v = inner(&value);

        if v.is::<String>() {
            "text".to_string()
        } else if v.is::<i64>() || v.is::<f64>() {
            "number".to_string()
        } else if v.is::<bool>() {
            "flag".to_string()
        } else if v.is::<()>() {
            "void".to_string()
        } else {
            "record".to_string()
        }
    }
}
