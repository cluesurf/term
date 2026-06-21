mod eddsa {
    use ed25519_dalek::{Signer, Verifier, SigningKey, VerifyingKey, Signature};
    use rand::rngs::OsRng;
    fn from_hex(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }
    fn to_hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{:02x}", b)).collect() }
    pub fn make_key_pair() -> String {
        let signing = SigningKey::generate(&mut OsRng);
        format!("{}{}", to_hex(&signing.to_bytes()), to_hex(signing.verifying_key().as_bytes()))
    }
    pub fn sign(private_hex: String, message: String) -> String {
        let seed: [u8; 32] = from_hex(&private_hex).try_into().unwrap();
        let signing = SigningKey::from_bytes(&seed);
        to_hex(&signing.sign(message.as_bytes()).to_bytes())
    }
    pub fn verify(public_hex: String, message: String, signature_hex: String) -> bool {
        let public_bytes: [u8; 32] = match from_hex(&public_hex).try_into() { Ok(b) => b, Err(_) => return false };
        let signature_bytes: [u8; 64] = match from_hex(&signature_hex).try_into() { Ok(b) => b, Err(_) => return false };
        let verifying = match VerifyingKey::from_bytes(&public_bytes) { Ok(k) => k, Err(_) => return false };
        verifying.verify(message.as_bytes(), &Signature::from_bytes(&signature_bytes)).is_ok()
    }
}
