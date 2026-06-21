mod text {
    pub fn concat(a: String, b: String) -> String { format!("{}{}", a, b) }
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
