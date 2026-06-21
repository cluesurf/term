// AES-256-GCM over the aes-gcm crate. Key, nonce, plaintext, and ciphertext are raw bytes; the ciphertext carries the
// 16-byte GCM tag appended. Reached only through the public cipher API.
mod cipher {
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use aes_gcm::aead::{Aead, KeyInit};
    pub fn encrypt(key: Vec<u8>, nonce: Vec<u8>, plain: Vec<u8>) -> Vec<u8> {
        let key = Key::<Aes256Gcm>::clone_from_slice(&key);
        let gcm = Aes256Gcm::new(&key);
        let nonce = Nonce::from_slice(&nonce);
        gcm.encrypt(nonce, plain.as_ref()).unwrap()
    }
    pub fn decrypt(key: Vec<u8>, nonce: Vec<u8>, sealed: Vec<u8>) -> Vec<u8> {
        let key = Key::<Aes256Gcm>::clone_from_slice(&key);
        let gcm = Aes256Gcm::new(&key);
        let nonce = Nonce::from_slice(&nonce);
        gcm.decrypt(nonce, sealed.as_ref()).unwrap()
    }
}
