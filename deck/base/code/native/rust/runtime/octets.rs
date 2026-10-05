// Raw byte buffers over rust. The currency value is Vec<u8>, passed by value (a move, so zero copy). Hex and base64
// are inlined: base64 went through the base64 crate, so any program whose imports reached the text module (a number
// read, a slider) failed to build with a bare rustc (test/view/terminal-words.ts). Standard alphabet, padded
// (RFC 4648 section 4); malformed input decodes to nothing, as the crate's `unwrap_or_default` did.
mod octets {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn from_text(text: String) -> Vec<u8> { text.into_bytes() }
    pub fn to_text(value: Vec<u8>) -> String { String::from_utf8(value).unwrap_or_default() }
    pub fn to_hex(value: Vec<u8>) -> String { value.iter().map(|byte| format!("{:02x}", byte)).collect() }
    pub fn from_hex(text: String) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap_or(0)).collect()
    }
    pub fn to_base64(value: Vec<u8>) -> String {
        let mut out = String::with_capacity(value.len().div_ceil(3) * 4);
        for chunk in value.chunks(3) {
            let a = chunk[0] as u32;
            let b = *chunk.get(1).unwrap_or(&0) as u32;
            let c = *chunk.get(2).unwrap_or(&0) as u32;
            let joined = (a << 16) | (b << 8) | c;
            out.push(ALPHABET[(joined >> 18) as usize & 63] as char);
            out.push(ALPHABET[(joined >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { ALPHABET[(joined >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { ALPHABET[joined as usize & 63] as char } else { '=' });
        }
        out
    }
    pub fn from_base64(text: String) -> Vec<u8> {
        let bytes: Vec<u8> = text.bytes().filter(|byte| *byte != b'=').collect();
        let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
        let mut joined: u32 = 0;
        let mut held = 0;
        for byte in bytes {
            let Some(index) = ALPHABET.iter().position(|letter| *letter == byte) else { return Vec::new() };
            joined = (joined << 6) | index as u32;
            held += 6;
            if held >= 8 {
                held -= 8;
                out.push((joined >> held) as u8);
                joined &= (1 << held) - 1;
            }
        }
        out
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
