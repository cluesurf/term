// Base64 text over rust, inlined rather than through the base64 crate, so a program builds with a bare rustc. Standard
// alphabet, padded (RFC 4648 section 4). Decoding malformed input, or bytes that are not UTF-8, gives empty text, as
// the crate's `unwrap_or_default` did. The same code as octets.rs, which is prepended on its own.
mod base64 {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(input: String) -> String {
        let value = input.into_bytes();
        let mut out = String::with_capacity((value.len() + 2) / 3 * 4);
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
    pub fn decode(input: String) -> String {
        let bytes: Vec<u8> = input.bytes().filter(|byte| *byte != b'=').collect();
        let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
        let mut joined: u32 = 0;
        let mut held = 0;
        for byte in bytes {
            let Some(index) = ALPHABET.iter().position(|letter| *letter == byte) else { return String::new() };
            joined = (joined << 6) | index as u32;
            held += 6;
            if held >= 8 {
                held -= 8;
                out.push((joined >> held) as u8);
                joined &= (1 << held) - 1;
            }
        }
        String::from_utf8(out).unwrap_or_default()
    }
}
