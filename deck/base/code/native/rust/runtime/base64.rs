mod base64 {
    use ::base64::Engine;
    pub fn encode(input: String) -> String { ::base64::engine::general_purpose::STANDARD.encode(input.as_bytes()) }
    pub fn decode(input: String) -> String {
        ::base64::engine::general_purpose::STANDARD.decode(input).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
    }
}
