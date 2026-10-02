mod hex {
    pub fn encode(input: String) -> String { ::hex::encode(input.as_bytes()) }
    pub fn decode(input: String) -> String {
        ::hex::decode(input).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
    }
}
