mod regex {
    // The one regex primitive over the regex crate. The pattern arrives in a form this engine reads as Term does
    // (base/code/pattern/analyze.tree, `native-text`); this runs it and turns byte offsets into code point offsets.
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
        // an engine that refuses the pattern answers [-2], never "no match": Term answers it with its own tier
        let engine = match engine {
            Some(engine) => engine,
            None => return vec![-2],
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

    // every match left to right, none overlapping, in one pass: the width of one match's slots first (two per group,
    // group 0 the whole match), then each match's slots in code points. After an empty match the search moves on one
    // code point, as the Term search does. Not `captures_iter`, whose rule for an empty match at the end of the last
    // one differs from JavaScript's; this loop is the same on every backend.
    pub fn search_all(pattern: String, text: String) -> Vec<i64> {
        let mut out: Vec<i64> = vec![-1];
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
        // an engine that refuses the pattern answers [-2], never "no match": Term answers it with its own tier
        let engine = match engine {
            Some(engine) => engine,
            None => return vec![-2],
        };
        // a cursor: the code point count at a byte offset, moved forwards only
        let mut cursor_byte = 0usize;
        let mut cursor_point = 0i64;
        let mut byte = 0usize;
        while byte <= text.len() {
            let caps = match engine.captures_at(&text, byte) {
                Some(caps) => caps,
                None => break,
            };
            let whole = caps.get(0).expect("group 0 is the match");
            let start_point = cursor_point + text[cursor_byte..whole.start()].chars().count() as i64;
            cursor_byte = whole.start();
            cursor_point = start_point;
            out[0] = (caps.len() * 2) as i64;
            for group in caps.iter() {
                match group {
                    Some(m) => {
                        out.push(start_point + text[whole.start()..m.start()].chars().count() as i64);
                        out.push(start_point + text[whole.start()..m.end()].chars().count() as i64);
                    }
                    None => {
                        out.push(-1);
                        out.push(-1);
                    }
                }
            }
            if whole.end() > whole.start() {
                byte = whole.end();
            } else {
                match text[whole.end()..].chars().next() {
                    Some(c) => byte = whole.end() + c.len_utf8(),
                    None => break,
                }
            }
        }
        out
    }
}
