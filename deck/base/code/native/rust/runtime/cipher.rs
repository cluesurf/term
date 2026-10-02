// AES-256-GCM over the aes-gcm crate. Key, nonce, plaintext, ciphertext and the additional authenticated data are raw
// bytes; the ciphertext carries the 16-byte GCM tag appended. Reached only through the public cipher API.
//
// `extra` is covered by the tag and is not part of the ciphertext, so a sealed value carries the context it was sealed
// in and cannot be moved to another slot without failing to open. `Payload` is the crate's own shape for it, so
// nothing here implements anything. Empty authenticates nothing, which is GCM's own default.
mod cipher {
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    pub fn encrypt(key: Vec<u8>, nonce: Vec<u8>, plain: Vec<u8>, extra: Vec<u8>) -> Vec<u8> {
        let key = Key::<Aes256Gcm>::clone_from_slice(&key);
        let gcm = Aes256Gcm::new(&key);
        let nonce = Nonce::from_slice(&nonce);
        gcm.encrypt(nonce, Payload { msg: plain.as_ref(), aad: extra.as_ref() }).unwrap()
    }
    pub fn decrypt(key: Vec<u8>, nonce: Vec<u8>, sealed: Vec<u8>, extra: Vec<u8>) -> Vec<u8> {
        let key = Key::<Aes256Gcm>::clone_from_slice(&key);
        let gcm = Aes256Gcm::new(&key);
        let nonce = Nonce::from_slice(&nonce);
        gcm.decrypt(nonce, Payload { msg: sealed.as_ref(), aad: extra.as_ref() }).unwrap()
    }
}
