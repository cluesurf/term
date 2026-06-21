mod regex {
    pub fn matches(pattern: String, text: String) -> bool {
        ::regex::Regex::new(&pattern).map(|r| r.is_match(&text)).unwrap_or(false)
    }
    pub fn replace(pattern: String, text: String, replacement: String) -> String {
        ::regex::Regex::new(&pattern).map(|r| r.replace_all(&text, replacement.as_str()).to_string()).unwrap_or(text)
    }
    pub fn find(pattern: String, text: String) -> String {
        ::regex::Regex::new(&pattern).ok().and_then(|r| r.find(&text).map(|m| m.as_str().to_string())).unwrap_or_default()
    }
}
