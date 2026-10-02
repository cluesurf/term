// X25519 ECDH over java.security (built into the JDK since 11, no extra dependency). Keys and the shared secret are
// raw bytes (ByteArray): a key-pair is the 32-byte private key and 32-byte public key concatenated (64 bytes); the
// shared secret is the raw 32-byte X25519 output. To rebuild a key from raw bytes the fixed X25519 DER prefixes are
// prepended (PKCS8 for private, X.509 for public). Fully qualified (no top-level imports) so the file can be prepended
// as a runtime prelude. Reached only through the public key-agreement API.
object x25519 {
    private const val PKCS8_PREFIX = "302e020100300506032b656e04220420"
    private const val SPKI_PREFIX = "302a300506032b656e032100"
    private fun fromHex(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    fun makeKeyPair(): ByteArray {
        val pair = java.security.KeyPairGenerator.getInstance("X25519").generateKeyPair()
        val scalar = (pair.private as java.security.interfaces.XECPrivateKey).scalar.get()
        val encoded = pair.public.encoded
        val public = encoded.copyOfRange(encoded.size - 32, encoded.size)
        return scalar + public
    }
    fun sharedSecret(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        val priv = java.security.KeyFactory.getInstance("X25519")
            .generatePrivate(java.security.spec.PKCS8EncodedKeySpec(fromHex(PKCS8_PREFIX) + privateKey))
        val pub = java.security.KeyFactory.getInstance("X25519")
            .generatePublic(java.security.spec.X509EncodedKeySpec(fromHex(SPKI_PREFIX) + publicKey))
        val agreement = javax.crypto.KeyAgreement.getInstance("X25519")
        agreement.init(priv)
        agreement.doPhase(pub, true)
        return agreement.generateSecret()
    }
}
