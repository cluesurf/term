// Ed25519 signatures over java.security (built into the JDK since 15, no extra dependency). Keys, messages, and
// signatures are raw bytes (ByteArray): a key-pair is the 32-byte private seed and 32-byte public key concatenated
// (64 bytes). To rebuild a key from raw bytes the fixed Ed25519 DER prefixes are prepended (PKCS8 for private, X.509
// for public). Fully qualified (no top-level imports) so the file can be prepended as a runtime prelude. Reached only
// through the public signature API.
object eddsa {
    private const val PKCS8_PREFIX = "302e020100300506032b657004220420"
    private const val SPKI_PREFIX = "302a300506032b6570032100"
    private fun fromHex(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    fun makeKeyPair(): ByteArray {
        val pair = java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val seed = (pair.private as java.security.interfaces.EdECPrivateKey).bytes.get()
        val encoded = pair.public.encoded
        val public = encoded.copyOfRange(encoded.size - 32, encoded.size)
        return seed + public
    }
    fun sign(privateKey: ByteArray, message: ByteArray): ByteArray {
        val key = java.security.KeyFactory.getInstance("Ed25519")
            .generatePrivate(java.security.spec.PKCS8EncodedKeySpec(fromHex(PKCS8_PREFIX) + privateKey))
        val signer = java.security.Signature.getInstance("Ed25519")
        signer.initSign(key)
        signer.update(message)
        return signer.sign()
    }
    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        val key = java.security.KeyFactory.getInstance("Ed25519")
            .generatePublic(java.security.spec.X509EncodedKeySpec(fromHex(SPKI_PREFIX) + publicKey))
        val verifier = java.security.Signature.getInstance("Ed25519")
        verifier.initVerify(key)
        verifier.update(message)
        return verifier.verify(signature)
    }
}
