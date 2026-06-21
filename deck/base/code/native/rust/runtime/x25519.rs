mod x25519 {
    use x25519_dalek::{StaticSecret, PublicKey};
    use rand::rngs::OsRng;
    use rand::RngCore;
    fn from_hex(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }
    fn to_hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{:02x}", b)).collect() }
    pub fn make_key_pair() -> String {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let secret = StaticSecret::from(seed);
        let public = PublicKey::from(&secret);
        format!("{}{}", to_hex(&secret.to_bytes()), to_hex(public.as_bytes()))
    }
    pub fn shared_secret(private_hex: String, public_hex: String) -> String {
        let private_bytes: [u8; 32] = from_hex(&private_hex).try_into().unwrap();
        let public_bytes: [u8; 32] = from_hex(&public_hex).try_into().unwrap();
        let secret = StaticSecret::from(private_bytes);
        let public = PublicKey::from(public_bytes);
        to_hex(secret.diffie_hellman(&public).as_bytes())
    }
}
