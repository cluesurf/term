mod crypto {
    use sha2::{Sha256, Sha512, Digest};
    use hmac::{Hmac, Mac};
    pub fn sha256(input: Vec<u8>) -> Vec<u8> { Sha256::digest(&input).to_vec() }
    pub fn sha512(input: Vec<u8>) -> Vec<u8> { Sha512::digest(&input).to_vec() }
    pub fn md5(input: Vec<u8>) -> Vec<u8> { ::md5::Md5::digest(&input).to_vec() }
    pub fn hmac_sha256(key: Vec<u8>, data: Vec<u8>) -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
        mac.update(&data);
        mac.finalize().into_bytes().to_vec()
    }
    pub fn hmac_sha512(key: Vec<u8>, data: Vec<u8>) -> Vec<u8> {
        let mut mac = Hmac::<Sha512>::new_from_slice(&key).unwrap();
        mac.update(&data);
        mac.finalize().into_bytes().to_vec()
    }
    pub fn random_bytes(size: i64) -> Vec<u8> {
        use ::rand::RngCore;
        use ::rand::rngs::OsRng;
        let mut buffer = vec![0u8; size as usize];
        OsRng.fill_bytes(&mut buffer);
        buffer
    }
    // equal without leaking where they differ: every byte is read whatever the earlier ones held, and black_box
    // keeps the optimizer from turning the fold back into an early exit. A length difference answers at once
    // PBKDF2 over HMAC-SHA256 (RFC 8018), written out so its bytes are the other backends' by construction
    pub fn pbkdf2_sha256(password: Vec<u8>, salt: Vec<u8>, iterations: i64, length: i64) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut block: u32 = 1;
        while (out.len() as i64) < length {
            let mut mac = Hmac::<Sha256>::new_from_slice(&password).unwrap();
            mac.update(&salt);
            mac.update(&block.to_be_bytes());
            let mut u = mac.finalize().into_bytes().to_vec();
            let mut t = u.clone();
            for _ in 1..iterations.max(1) {
                let mut next = Hmac::<Sha256>::new_from_slice(&password).unwrap();
                next.update(&u);
                u = next.finalize().into_bytes().to_vec();
                for (a, b) in t.iter_mut().zip(u.iter()) { *a ^= b; }
            }
            out.extend_from_slice(&t);
            block += 1;
        }
        out.truncate(length.max(0) as usize);
        out
    }
    // HKDF over HMAC-SHA256 (RFC 5869): extract with the salt (32 zero bytes when empty), then expand with the info
    pub fn hkdf_sha256(key: Vec<u8>, salt: Vec<u8>, info: Vec<u8>, length: i64) -> Vec<u8> {
        let salt = if salt.is_empty() { vec![0u8; 32] } else { salt };
        let mut extract = Hmac::<Sha256>::new_from_slice(&salt).unwrap();
        extract.update(&key);
        let prk = extract.finalize().into_bytes().to_vec();
        let mut out: Vec<u8> = Vec::new();
        let mut t: Vec<u8> = Vec::new();
        let mut i: u8 = 1;
        while (out.len() as i64) < length {
            let mut expand = Hmac::<Sha256>::new_from_slice(&prk).unwrap();
            expand.update(&t);
            expand.update(&info);
            expand.update(&[i]);
            t = expand.finalize().into_bytes().to_vec();
            out.extend_from_slice(&t);
            i = i.wrapping_add(1);
        }
        out.truncate(length.max(0) as usize);
        out
    }
    pub fn equal_secret(a: Vec<u8>, b: Vec<u8>) -> bool {
        if a.len() != b.len() { return false; }
        let mut diff = 0u8;
        for i in 0..a.len() { diff |= std::hint::black_box(a[i] ^ b[i]); }
        std::hint::black_box(diff) == 0
    }
}
