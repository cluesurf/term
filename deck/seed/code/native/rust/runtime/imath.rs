// Integer math over rust (i64). Mirrors the host Math operations the other targets use. Reached only through the
// public math API.
mod imath {
    pub fn abs(value: i64) -> i64 { value.abs() }
    pub fn min(a: i64, b: i64) -> i64 { a.min(b) }
    pub fn max(a: i64, b: i64) -> i64 { a.max(b) }
    pub fn pow(base: i64, exponent: i64) -> i64 { base.pow(exponent as u32) }
    pub fn signum(value: i64) -> i64 { value.signum() }
    pub fn sqrt(value: i64) -> i64 { (value as f64).sqrt() as i64 }
    pub fn log(value: i64) -> i64 { (value as f64).ln() as i64 }
}
