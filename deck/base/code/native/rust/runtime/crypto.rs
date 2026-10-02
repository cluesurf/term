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
}
