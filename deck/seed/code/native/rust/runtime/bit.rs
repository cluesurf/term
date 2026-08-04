// Bitwise integer operations over rust (full 64-bit). Reached only through the public bit API.
mod bit {
    pub fn and(left: i64, right: i64) -> i64 { left & right }
    pub fn or(left: i64, right: i64) -> i64 { left | right }
    pub fn exclusive_or(left: i64, right: i64) -> i64 { left ^ right }
    pub fn not(value: i64) -> i64 { !value }
    pub fn shift_left(value: i64, count: i64) -> i64 { value << (count as u32) }
    pub fn shift_right(value: i64, count: i64) -> i64 { value >> (count as u32) }
    pub fn shift_right_unsigned(value: i64, count: i64) -> i64 { ((value as u64) >> (count as u32)) as i64 }
}
