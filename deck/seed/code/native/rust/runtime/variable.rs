// Environment variable runtime. Reached only through the public environment API, which is why the platform idioms
// (the `Result` from `env::var`, the borrow at each call) stay here rather than leaking into the seed source.
mod variable {
    use std::collections::HashMap;

    pub fn get(name: String) -> String {
        std::env::var(&name).unwrap_or_default()
    }

    pub fn set(name: String, value: String) {
        std::env::set_var(&name, &value)
    }

    pub fn remove(name: String) {
        std::env::remove_var(&name)
    }

    pub fn list() -> HashMap<String, String> {
        std::env::vars().collect()
    }

    pub fn check(name: String) -> bool {
        std::env::var(&name).is_ok()
    }
}
