mod random {
    use ::rand::Rng;
    pub fn number() -> i64 { 0 }
    pub fn integer(low: i64, high: i64) -> i64 { ::rand::thread_rng().gen_range(low..=high) }
}
