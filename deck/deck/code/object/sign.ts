/**
 * Ed25519 signing and verification for commits and version tags.
 *
 * A publish is authenticated by signing the commit id (a Merkle root over
 * the whole package) with a keypair the publisher controls. A client, or
 * the registry, verifies the signature against a public key bound to the
 * scope. Because the signature covers the content hash, it binds the
 * exact bytes to the signer (see note/term/registry/07).
 *
 * Signatures are carried beside the object as `ed25519:<base64>` and the
 * public key as `<base64>`, never inside the signed object, so the object
 * id stays stable.
 */

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
  KeyObject,
} from 'crypto'

const SIG_PREFIX = 'ed25519:'

/** A signing identity: a public key (shareable) and private key (secret). */
export type Keypair = {
  publicKey: string
  privateKey: string
}

/** Generate a fresh ed25519 keypair, encoded as base64 raw-ish (SPKI/PKCS8 DER base64). */
export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  return {
    publicKey: publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
    privateKey: privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64'),
  }
}

function loadPublic(publicKey: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
}

function loadPrivate(privateKey: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
}

/** Sign a commit id (or any id string) with a private key. Returns `ed25519:<base64>`. */
export function signId(input: {
  id: string
  privateKey: string
}): string {
  const sig = cryptoSign(
    null,
    Buffer.from(input.id, 'utf8'),
    loadPrivate(input.privateKey),
  )

  return `${SIG_PREFIX}${sig.toString('base64')}`
}

/** Verify a signature over an id against a public key. */
export function verifyId(input: {
  id: string
  sig: string
  publicKey: string
}): boolean {
  if (!input.sig.startsWith(SIG_PREFIX)) {
    return false
  }

  const sigBytes = Buffer.from(input.sig.slice(SIG_PREFIX.length), 'base64')

  try {
    return cryptoVerify(
      null,
      Buffer.from(input.id, 'utf8'),
      loadPublic(input.publicKey),
      sigBytes,
    )
  } catch {
    return false
  }
}
