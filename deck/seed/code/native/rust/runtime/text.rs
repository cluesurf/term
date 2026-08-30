mod text {
    pub fn concat(a: String, b: String) -> String { format!("{}{}", a, b) }
    pub fn from_value<T: 'static>(value: T) -> String {
        let v: &dyn std::any::Any = &value;
        let v: &dyn std::any::Any = match v.downcast_ref::<std::rc::Rc<dyn std::any::Any>>() {
            Some(boxed) => boxed.as_ref(),
            None => v,
        };
        if let Some(s) = v.downcast_ref::<String>() { return s.clone() }
        if let Some(n) = v.downcast_ref::<i64>() { return n.to_string() }
        if let Some(n) = v.downcast_ref::<f64>() { return n.to_string() }
        if let Some(b) = v.downcast_ref::<bool>() { return b.to_string() }
        String::new()
    }
    pub fn upper(s: String) -> String { s.to_uppercase() }
    pub fn lower(s: String) -> String { s.to_lowercase() }
    pub fn trim(s: String) -> String { s.trim().to_string() }
    pub fn repeated(s: String, n: i64) -> String { s.repeat(n as usize) }
    pub fn contains(s: String, part: String) -> bool { s.contains(&part) }
    pub fn starts_with(s: String, prefix: String) -> bool { s.starts_with(&prefix) }
    pub fn ends_with(s: String, suffix: String) -> bool { s.ends_with(&suffix) }
    pub fn replace(s: String, from: String, to: String) -> String { s.replace(&from, &to) }
    pub fn slice(s: String, start: i64, end: i64) -> String {
        s.chars().skip(start as usize).take((end - start) as usize).collect()
    }
}
