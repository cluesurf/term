// Digests, HMAC, and secure random over java.security / javax.crypto (built into the JDK). All inputs and outputs are
// raw bytes (ByteArray). Fully qualified (no top-level imports) so the file can be prepended as a runtime prelude.
// Reached only through the public digest / hmac / random APIs.
object crypto {
    private fun digestBytes(algorithm: String, input: ByteArray): ByteArray =
        java.security.MessageDigest.getInstance(algorithm).digest(input)
    fun sha256(input: ByteArray): ByteArray = digestBytes("SHA-256", input)
    fun sha512(input: ByteArray): ByteArray = digestBytes("SHA-512", input)
    fun md5(input: ByteArray): ByteArray = digestBytes("MD5", input)
    private fun mac(algorithm: String, key: ByteArray, data: ByteArray): ByteArray {
        val instance = javax.crypto.Mac.getInstance(algorithm)
        instance.init(javax.crypto.spec.SecretKeySpec(key, algorithm))
        return instance.doFinal(data)
    }
    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray = mac("HmacSHA256", key, data)
    fun hmacSha512(key: ByteArray, data: ByteArray): ByteArray = mac("HmacSHA512", key, data)
    fun randomBytes(size: Long): ByteArray {
        val bytes = ByteArray(size.toInt())
        java.security.SecureRandom().nextBytes(bytes)
        return bytes
    }
}
