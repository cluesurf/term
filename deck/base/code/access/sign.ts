import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
} from 'node:crypto'

// Signed authorship. Every commit can be signed so a contributor's identity cannot
// be forged, and the content-addressed history makes any tampering evident by
// construction. Uses ed25519 (small, fast, no long-lived-key ceremony). Keys are
// carried as PEM strings for portability; a real deployment ties the key to the
// base.surf identity (keyless Sigstore style).
//
// See note/library/base/design/access-control-and-authorship.md.

export type Keypair = { publicKey: string; privateKey: string }

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

// Sign a commit hash, returning a hex signature.
export function signCommit(commitHash: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  const sig = cryptoSign(null, Buffer.from(commitHash, 'utf8'), key)
  return sig.toString('hex')
}

// Verify a signature over a commit hash.
export function verifyCommit(
  commitHash: string,
  signatureHex: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem)
    return cryptoVerify(
      null,
      Buffer.from(commitHash, 'utf8'),
      key,
      Buffer.from(signatureHex, 'hex'),
    )
  } catch {
    return false
  }
}
