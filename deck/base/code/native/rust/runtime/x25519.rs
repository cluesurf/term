// X25519 ECDH over the x25519-dalek crate. Keys and the shared secret are raw bytes: a key-pair is the 32-byte
// private key and 32-byte public key concatenated (64 bytes); the shared secret is the raw 32-byte output. Reached
// only through the public key-agreement API.
mod x25519 {
    use x25519_dalek::{StaticSecret, PublicKey};
    use rand::rngs::OsRng;
    use rand::RngCore;
    pub fn make_key_pair() -> Vec<u8> {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let secret = StaticSecret::from(seed);
        let public = PublicKey::from(&secret);
        let mut out = Vec::with_capacity(64);
        out.extend_from_slice(&secret.to_bytes());
        out.extend_from_slice(public.as_bytes());
        out
    }
    pub fn shared_secret(private_key: Vec<u8>, public_key: Vec<u8>) -> Vec<u8> {
        let private_bytes: [u8; 32] = private_key.try_into().unwrap();
        let public_bytes: [u8; 32] = public_key.try_into().unwrap();
        let secret = StaticSecret::from(private_bytes);
        let public = PublicKey::from(public_bytes);
        secret.diffie_hellman(&public).as_bytes().to_vec()
    }
}
