import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.EdECPrivateKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

// Ed25519 signatures over java.security (built into the JDK since 15, no extra dependency). The raw 32-byte private
// seed is read straight off the key (EdECPrivateKey.bytes); the 32-byte public key is the tail of its X.509 encoding.
// To rebuild a key from raw bytes the fixed Ed25519 DER prefixes are prepended (PKCS8 for private, X.509 for public).
object eddsa {
    private const val PKCS8_PREFIX = "302e020100300506032b657004220420"
    private const val SPKI_PREFIX = "302a300506032b6570032100"
    private fun fromHex(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    fun makeKeyPair(): String {
        val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val seed = (pair.private as EdECPrivateKey).bytes.get()
        val encoded = pair.public.encoded
        val public = encoded.copyOfRange(encoded.size - 32, encoded.size)
        return toHex(seed) + toHex(public)
    }
    fun sign(privateHex: String, message: String): String {
        val key = KeyFactory.getInstance("Ed25519").generatePrivate(PKCS8EncodedKeySpec(fromHex(PKCS8_PREFIX + privateHex)))
        val signer = Signature.getInstance("Ed25519")
        signer.initSign(key)
        signer.update(message.toByteArray(Charsets.UTF_8))
        return toHex(signer.sign())
    }
    fun verify(publicHex: String, message: String, signatureHex: String): Boolean {
        val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(fromHex(SPKI_PREFIX + publicHex)))
        val verifier = Signature.getInstance("Ed25519")
        verifier.initVerify(key)
        verifier.update(message.toByteArray(Charsets.UTF_8))
        return verifier.verify(fromHex(signatureHex))
    }
}
