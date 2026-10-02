// Environment variable runtime. Reached only through the public environment API, which is why the platform idioms
// (the `Result` from `env::var`, the borrow at each call) stay here rather than leaking into the seed source.
mod variable {
    pub fn get(name: String) -> String {
        std::env::var(&name).unwrap_or_default()
    }

    pub fn set(name: String, value: String) {
        std::env::set_var(&name, &value)
    }

    pub fn remove(name: String) {
        std::env::remove_var(&name)
    }

    // the Term hash representation: a reference-counted mutable map, insertion-ordered (the emitted `TermMap`). The
    // variables are sorted by name first, so a walk over them is the same on every run and every backend
    pub fn list() -> std::rc::Rc<std::cell::RefCell<crate::TermMap<String, String>>> {
        let mut vars: Vec<(String, String)> = std::env::vars().collect();
        vars.sort();
        std::rc::Rc::new(std::cell::RefCell::new(vars.into_iter().collect()))
    }

    pub fn check(name: String) -> bool {
        std::env::var(&name).is_ok()
    }
}
