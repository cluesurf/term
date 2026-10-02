// Ed25519 signatures over the ed25519-dalek crate. Keys, messages, and signatures are raw bytes: a key-pair is the
// 32-byte private seed and 32-byte public key concatenated (64 bytes). Reached only through the public signature API.
mod eddsa {
    use ed25519_dalek::{Signer, Verifier, SigningKey, VerifyingKey, Signature};
    use rand::rngs::OsRng;
    pub fn make_key_pair() -> Vec<u8> {
        let signing = SigningKey::generate(&mut OsRng);
        let mut out = Vec::with_capacity(64);
        out.extend_from_slice(&signing.to_bytes());
        out.extend_from_slice(signing.verifying_key().as_bytes());
        out
    }
    pub fn sign(private_key: Vec<u8>, message: Vec<u8>) -> Vec<u8> {
        let seed: [u8; 32] = private_key.try_into().unwrap();
        let signing = SigningKey::from_bytes(&seed);
        signing.sign(&message).to_bytes().to_vec()
    }
    pub fn verify(public_key: Vec<u8>, message: Vec<u8>, signature: Vec<u8>) -> bool {
        let public_bytes: [u8; 32] = match public_key.try_into() { Ok(b) => b, Err(_) => return false };
        let signature_bytes: [u8; 64] = match signature.try_into() { Ok(b) => b, Err(_) => return false };
        let verifying = match VerifyingKey::from_bytes(&public_bytes) { Ok(k) => k, Err(_) => return false };
        verifying.verify(&message, &Signature::from_bytes(&signature_bytes)).is_ok()
    }
}
