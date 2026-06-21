mod cipher {
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use aes_gcm::aead::{Aead, KeyInit};
    fn from_hex(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }
    fn to_hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{:02x}", b)).collect() }
    pub fn encrypt(key_hex: String, nonce_hex: String, plain: String) -> String {
        let key = Key::<Aes256Gcm>::clone_from_slice(&from_hex(&key_hex));
        let gcm = Aes256Gcm::new(&key);
        let nonce_bytes = from_hex(&nonce_hex);
        let nonce = Nonce::from_slice(&nonce_bytes);
        to_hex(&gcm.encrypt(nonce, plain.as_bytes()).unwrap())
    }
    pub fn decrypt(key_hex: String, nonce_hex: String, cipher_hex: String) -> String {
        let key = Key::<Aes256Gcm>::clone_from_slice(&from_hex(&key_hex));
        let gcm = Aes256Gcm::new(&key);
        let nonce_bytes = from_hex(&nonce_hex);
        let nonce = Nonce::from_slice(&nonce_bytes);
        String::from_utf8(gcm.decrypt(nonce, from_hex(&cipher_hex).as_ref()).unwrap()).unwrap()
    }
}
