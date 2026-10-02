// Raw byte buffers over rust. The currency value is Vec<u8>, passed by value (a move, so zero copy). Hex is inlined,
// base64 goes through the base64 crate.
mod bytes {
    use base64::Engine;
    pub fn from_text(text: String) -> Vec<u8> { text.into_bytes() }
    pub fn to_text(value: Vec<u8>) -> String { String::from_utf8(value).unwrap_or_default() }
    pub fn to_hex(value: Vec<u8>) -> String { value.iter().map(|byte| format!("{:02x}", byte)).collect() }
    pub fn from_hex(text: String) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap_or(0)).collect()
    }
    pub fn to_base64(value: Vec<u8>) -> String { base64::engine::general_purpose::STANDARD.encode(value) }
    pub fn from_base64(text: String) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(text).unwrap_or_default()
    }
    pub fn length(value: Vec<u8>) -> i64 { value.len() as i64 }
    pub fn concat(left: Vec<u8>, right: Vec<u8>) -> Vec<u8> {
        let mut out = left;
        out.extend(right);
        out
    }
    pub fn slice(value: Vec<u8>, start: i64, end: i64) -> Vec<u8> {
        value[start as usize..end as usize].to_vec()
    }
}
