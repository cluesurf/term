// Runtime shape checks. Rust erases types at compile time, so each check is generic over whatever the call
// site actually holds: a concrete value (i64, String, a Vec handle) answers from its own type, and a boxed
// dynamic (`Rc<dyn Any>`, the backend's `unknown`) is unwrapped first and answered from its contents. A list
// of an element outside the boxed currencies answers `is_list` false, which is the honest limit of a
// type-erased box.
mod shape {
    use std::any::Any;
    use std::cell::RefCell;
    use crate::TermMap;
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

    // every Rust number, as type_of reads one (item term-self-host-001-1091): a bare integer literal handed to the
    // generic is an i32, and answered false here before
    pub fn is_number<T: 'static>(value: T) -> bool {
        number_like(inner(&value))
    }

    pub fn is_flag<T: 'static>(value: T) -> bool {
        inner(&value).is::<bool>()
    }

    pub fn is_list<T: 'static>(value: T) -> bool {
        list_like(inner(&value))
    }

    // every Rust number: a bare literal handed to a generic (`shape::type_of(7)`) is an i32, not the i64 a
    // Term number variable holds
    fn number_like(v: &dyn Any) -> bool {
        v.is::<i64>() || v.is::<f64>() || v.is::<i32>() || v.is::<f32>() || v.is::<i8>() || v.is::<i16>()
            || v.is::<i128>() || v.is::<isize>() || v.is::<u8>() || v.is::<u16>() || v.is::<u32>()
            || v.is::<u64>() || v.is::<u128>() || v.is::<usize>()
    }

    // a list literal no annotation fixes (`vec![1, 2]`) holds i32 or f64, so i32 and f32 lists count too
    fn list_like(v: &dyn Any) -> bool {
        v.is::<Rc<RefCell<Vec<Rc<dyn Any>>>>>()
            || v.is::<Rc<RefCell<Vec<String>>>>()
            || v.is::<Rc<RefCell<Vec<i64>>>>()
            || v.is::<Rc<RefCell<Vec<f64>>>>()
            || v.is::<Rc<RefCell<Vec<bool>>>>()
            || v.is::<Rc<RefCell<Vec<i32>>>>()
            || v.is::<Rc<RefCell<Vec<f32>>>>()
    }

    pub fn is_hash<T: 'static>(value: T) -> bool {
        let v = inner(&value);

        v.is::<Rc<RefCell<TermMap<String, Rc<dyn Any>>>>>()
            || v.is::<Rc<RefCell<TermMap<String, String>>>>()
            || v.is::<Rc<RefCell<TermMap<String, i64>>>>()
    }

    // Term's words, the same on every backend: `null`, `list`, `text`, `boolean`, `number` or `object` (item
    // term-self-host-001-1089). This answered `flag`, `void` and `record`, and a list as `record`, which no
    // other backend answers.
    pub fn type_of<T: 'static>(value: T) -> String {
        let v = inner(&value);

        if v.is::<()>() {
            "null".to_string()
        } else if list_like(v) {
            "list".to_string()
        } else if v.is::<String>() {
            "text".to_string()
        } else if v.is::<bool>() {
            "boolean".to_string()
        } else if number_like(v) {
            "number".to_string()
        } else {
            "object".to_string()
        }
    }
}
