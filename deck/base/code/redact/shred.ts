import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto'

// Crypto-shredding: erasing a value while keeping its position and hash stable. A
// sensitive field is stored encrypted, and erasure deletes the key, so the value
// becomes permanently unreadable while the structure and its content hash are
// untouched. This is how base honors a deletion request against content that must
// stay hash-stable (a citation depends on it).
//
// See note/library/base/design/deletion-and-legal-removal.md.

// A keyed store of encryption keys. Deleting a key here shreds the value it protects.
export class KeyStore {
  private keys = new Map<string, Buffer>()

  create(): string {
    const id = randomBytes(16).toString('hex')
    this.keys.set(id, randomBytes(32))
    return id
  }

  get(id: string): Buffer | undefined {
    return this.keys.get(id)
  }

  // Shred a key, making everything it encrypted permanently unrecoverable.
  shred(id: string): void {
    this.keys.delete(id)
  }
}

// The stored, encrypted payload. Its bytes and hash are stable across a shred; only
// its readability changes when the key is deleted.
export type Shredded = { keyId: string; payload: string }

export function shredEncrypt(plaintext: string, keys: KeyStore): Shredded {
  const keyId = keys.create()
  const key = keys.get(keyId)!
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([iv, tag, enc]).toString('base64')
  return { keyId, payload }
}

// Decrypt a payload, or undefined if the key has been shredded.
export function shredDecrypt(
  shredded: Shredded,
  keys: KeyStore,
): string | undefined {
  const key = keys.get(shredded.keyId)
  if (key === undefined) {
    return undefined
  }
  const raw = Buffer.from(shredded.payload, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const enc = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
