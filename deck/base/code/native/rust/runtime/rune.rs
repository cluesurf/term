// Rune (Unicode code point) predicates and case mapping over the standard library's char tables. Each takes a code
// point and returns a boolean, or the mapped code point (unchanged when the code point is invalid or has no mapping).
// Reached only through the public rune API.
mod rune {
    fn at(code: i64) -> Option<char> {
        char::from_u32(code as u32)
    }

    pub fn is_letter(code: i64) -> bool {
        at(code).map_or(false, |c| c.is_alphabetic())
    }
    pub fn is_number(code: i64) -> bool {
        at(code).map_or(false, |c| c.is_numeric())
    }
    pub fn is_whitespace(code: i64) -> bool {
        at(code).map_or(false, |c| c.is_whitespace())
    }
    pub fn is_uppercase(code: i64) -> bool {
        at(code).map_or(false, |c| c.is_uppercase())
    }
    pub fn is_lowercase(code: i64) -> bool {
        at(code).map_or(false, |c| c.is_lowercase())
    }
    pub fn is_alphanumeric(code: i64) -> bool {
        at(code).map_or(false, |c| c.is_alphanumeric())
    }
    pub fn is_control(code: i64) -> bool {
        at(code).map_or(false, |c| c.is_control())
    }
    pub fn to_uppercase(code: i64) -> i64 {
        at(code)
            .and_then(|c| c.to_uppercase().next())
            .map_or(code, |c| c as i64)
    }
    pub fn to_lowercase(code: i64) -> i64 {
        at(code)
            .and_then(|c| c.to_lowercase().next())
            .map_or(code, |c| c as i64)
    }
}
