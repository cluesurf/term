mod regex {
    // The one regex primitive over the regex crate. The pattern arrives in the canonical dialect
    // (base/code/regex/dialect.tree); this runs it and turns byte offsets into code point offsets.
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static COMPILED: RefCell<HashMap<String, ::regex::Regex>> = RefCell::new(HashMap::new());
    }

    pub fn search(pattern: String, text: String, from: i64) -> Vec<i64> {
        let mut out: Vec<i64> = Vec::new();
        let engine = COMPILED.with(|compiled| {
            let mut compiled = compiled.borrow_mut();
            if let Some(found) = compiled.get(&pattern) {
                return Some(found.clone());
            }
            match ::regex::Regex::new(&pattern) {
                Ok(made) => {
                    compiled.insert(pattern.clone(), made.clone());
                    Some(made)
                }
                Err(_) => None,
            }
        });
        let engine = match engine {
            Some(engine) => engine,
            None => return out,
        };
        if from < 0 {
            return out;
        }
        let mut byte = text.len();
        let mut point: i64 = 0;
        for (at, _) in text.char_indices() {
            if point == from {
                byte = at;
                break;
            }
            point += 1;
        }
        if point < from {
            return out;
        }
        if let Some(caps) = engine.captures_at(&text, byte) {
            for group in caps.iter() {
                match group {
                    Some(m) => {
                        out.push(from + text[byte..m.start()].chars().count() as i64);
                        out.push(from + text[byte..m.end()].chars().count() as i64);
                    }
                    None => {
                        out.push(-1);
                        out.push(-1);
                    }
                }
            }
        }
        out
    }
}
