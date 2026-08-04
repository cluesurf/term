// Cryptography runtime. Digest names are normalised from the seed spelling (`sha256`) to the JCA spelling
// (`SHA-256`), which is the only reason this needs a shim rather than a direct call. Reached only through the public
// cryptography API.
object cryptography {
    private fun standardName(algorithm: String): String = when (algorithm) {
        "sha256" -> "SHA-256"
        "sha384" -> "SHA-384"
        "sha512" -> "SHA-512"
        "md5" -> "MD5"
        "sha1" -> "SHA-1"
        else -> algorithm.uppercase()
    }

    fun digest(algorithm: String, data: String): String {
        val digest = java.security.MessageDigest.getInstance(standardName(algorithm))
        val bytes = digest.digest(data.toByteArray(Charsets.UTF_8))

        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun randomBytes(size: Long): ByteArray {
        val bytes = ByteArray(size.toInt())
        java.security.SecureRandom().nextBytes(bytes)

        return bytes
    }
}
