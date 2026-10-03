mod uuid {
    // A random (version 4) UUID, RFC 9562 section 5.4, with no crate, so a program that makes ids builds with a bare
    // rustc (terminal-target-0005: the blog as a Rust binary). The 16 bytes come from /dev/urandom where it exists
    // (macOS, Linux, the BSDs), and elsewhere from the standard library's per-process random hasher keys, which the
    // platform seeds from its own random source, mixed with the clock. Then the version (4) and the variant (10) bits.
    pub fn version4() -> String {
        let mut bytes = [0u8; 16];
        let read = std::fs::File::open("/dev/urandom").and_then(|mut file| {
            use std::io::Read;
            file.read_exact(&mut bytes)
        });
        if read.is_err() {
            use std::hash::{BuildHasher, Hasher};
            for chunk in bytes.chunks_mut(8) {
                let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or(0);
                hasher.write_u128(nanos);
                let value = hasher.finish().to_le_bytes();
                chunk.copy_from_slice(&value[..chunk.len()]);
            }
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex: String = bytes.iter().map(|byte| format!("{:02x}", byte)).collect();
        format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
    }
}
