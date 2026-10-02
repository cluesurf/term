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
    // equal without leaking where they differ: the JDK's MessageDigest.isEqual reads every byte (since 6u17). A length
    // difference answers at once
    fun equalSecret(a: ByteArray, b: ByteArray): Boolean = java.security.MessageDigest.isEqual(a, b)

    // HMAC-SHA256 over the parts in order. HMAC pads its key with zero bytes, so an empty key is the one zero byte
    // SecretKeySpec will accept (it refuses an empty array)
    private fun hmac256(key: ByteArray, vararg parts: ByteArray): ByteArray {
        val instance = javax.crypto.Mac.getInstance("HmacSHA256")
        instance.init(javax.crypto.spec.SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA256"))
        for (part in parts) instance.update(part)
        return instance.doFinal()
    }

    // PBKDF2 over HMAC-SHA256 (RFC 8018), written out rather than through PBEKeySpec, which takes the password as
    // chars and so cannot hold arbitrary bytes
    fun pbkdf2Sha256(password: ByteArray, salt: ByteArray, iterations: Long, length: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var block = 1
        while (out.size() < length) {
            val index = byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte())
            var u = hmac256(password, salt, index)
            val t = u.copyOf()
            for (round in 1 until maxOf(iterations, 1L)) {
                u = hmac256(password, u)
                for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
            }
            out.write(t)
            block += 1
        }
        return out.toByteArray().copyOf(maxOf(length, 0L).toInt())
    }

    // HKDF over HMAC-SHA256 (RFC 5869): extract with the salt (32 zero bytes when empty), then expand with the info
    fun hkdfSha256(key: ByteArray, salt: ByteArray, info: ByteArray, length: Long): ByteArray {
        val prk = hmac256(if (salt.isEmpty()) ByteArray(32) else salt, key)
        val out = java.io.ByteArrayOutputStream()
        var t = ByteArray(0)
        var i = 1
        while (out.size() < length) {
            t = hmac256(prk, t, info, byteArrayOf(i.toByte()))
            out.write(t)
            i += 1
        }
        return out.toByteArray().copyOf(maxOf(length, 0L).toInt())
    }
}
