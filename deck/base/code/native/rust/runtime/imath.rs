// Integer math over rust (i64). Mirrors the host Math operations the other targets use. Reached only through the
// public math API.
mod imath {
    // the integer or a stop (note/term/proof-by-default/numbers.md): `abs(i64::MIN)` has no i64 answer, and a release
    // build's `.abs()` and `.pow()` wrap in silence. A negative exponent is the real result truncated toward zero:
    // 0, except for a base of 1 or -1, as on Kotlin and Swift
    pub fn abs(value: i64) -> i64 { value.checked_abs().expect("excess: a number past i64") }
    pub fn min(a: i64, b: i64) -> i64 { a.min(b) }
    pub fn max(a: i64, b: i64) -> i64 { a.max(b) }
    pub fn pow(base: i64, exponent: i64) -> i64 {
        if exponent < 0 {
            return match base { 1 => 1, -1 => if exponent % 2 == 0 { 1 } else { -1 }, 0 => panic!("defect: zero to a negative power"), _ => 0 };
        }
        // an exponent past u32 is never computed: only 0, 1 and -1 survive one, and they are answered directly
        let exact = if exponent <= u32::MAX as i64 { base.checked_pow(exponent as u32) } else { None };
        exact.or(match base { 0 | 1 => Some(base), -1 => Some(if exponent % 2 == 0 { 1 } else { -1 }), _ => None }).expect("excess: a number past i64")
    }
    pub fn signum(value: i64) -> i64 { value.signum() }
    pub fn sqrt(value: i64) -> i64 { (value as f64).sqrt() as i64 }
    pub fn log(value: i64) -> i64 { (value as f64).ln() as i64 }
    pub fn sin(value: i64) -> i64 { (value as f64).sin() as i64 }
}
