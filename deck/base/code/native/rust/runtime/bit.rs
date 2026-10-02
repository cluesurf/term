// Bitwise integer operations over rust (full 64-bit). Reached only through the public bit API.
mod bit {
    pub fn and(left: i64, right: i64) -> i64 { left & right }
    pub fn or(left: i64, right: i64) -> i64 { left | right }
    pub fn exclusive_or(left: i64, right: i64) -> i64 { left ^ right }
    pub fn not(value: i64) -> i64 { !value }
    pub fn shift_left(value: i64, count: i64) -> i64 { value << (count as u32) }
    pub fn shift_right(value: i64, count: i64) -> i64 { value >> (count as u32) }
    pub fn shift_right_unsigned(value: i64, count: i64) -> i64 { ((value as u64) >> (count as u32)) as i64 }
    // A SIGNED 32-BIT MULTIPLY WITH WRAPAROUND, `Math.imul` semantics: the high bits are DISCARDED, which is
    // what the classic string hashes are defined in terms of. A 64-bit product would give a different number.
    pub fn multiply_32(left: i64, right: i64) -> i64 { (left as i32).wrapping_mul(right as i32) as i64 }
}
