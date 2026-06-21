import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.XECPrivateKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.KeyAgreement

// X25519 ECDH over java.security (built into the JDK since 11, no extra dependency). The raw 32-byte private key is
// read straight off the key (XECPrivateKey.scalar); the 32-byte public key is the tail of its X.509 encoding. To
// rebuild a key from raw bytes the fixed X25519 DER prefixes are prepended (PKCS8 for private, X.509 for public).
object x25519 {
    private const val PKCS8_PREFIX = "302e020100300506032b656e04220420"
    private const val SPKI_PREFIX = "302a300506032b656e032100"
    private fun fromHex(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    fun makeKeyPair(): String {
        val pair = KeyPairGenerator.getInstance("X25519").generateKeyPair()
        val scalar = (pair.private as XECPrivateKey).scalar.get()
        val encoded = pair.public.encoded
        val public = encoded.copyOfRange(encoded.size - 32, encoded.size)
        return toHex(scalar) + toHex(public)
    }
    fun sharedSecret(privateHex: String, publicHex: String): String {
        val privateKey = KeyFactory.getInstance("X25519").generatePrivate(PKCS8EncodedKeySpec(fromHex(PKCS8_PREFIX + privateHex)))
        val publicKey = KeyFactory.getInstance("X25519").generatePublic(X509EncodedKeySpec(fromHex(SPKI_PREFIX + publicHex)))
        val agreement = KeyAgreement.getInstance("X25519")
        agreement.init(privateKey)
        agreement.doPhase(publicKey, true)
        return toHex(agreement.generateSecret())
    }
}
