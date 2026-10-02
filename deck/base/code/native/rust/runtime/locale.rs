// Locale runtime. Reached only through the public environment API. Rust has no locale facility in the standard
// library, so the tag is read from `LANG` in the POSIX form (`en_GB.UTF-8`) and normalised to a BCP 47 tag.
mod tongue {
    pub fn tag() -> String {
        match std::env::var("LANG") {
            Ok(value) => value
                .split('.')
                .next()
                .unwrap_or("en")
                .replace('_', "-"),
            Err(_) => String::from("en"),
        }
    }

    pub fn timezone() -> String {
        std::env::var("TZ").unwrap_or_default()
    }

    pub fn preferred() -> Vec<String> {
        vec![tag()]
    }
}
