// Cryptography runtime for the Web platform. Digest names are normalised from the seed spelling (`sha256`) to the Web
// Crypto spelling (`SHA-256`). `digest` is async because `crypto.subtle` is. Reached only through the public
// cryptography API.
const cryptography = {
  digest: async (algorithm: string, data: string): Promise<string> => {
    const names: Record<string, string> = {
      sha256: 'SHA-256',
      sha384: 'SHA-384',
      sha512: 'SHA-512',
      sha1: 'SHA-1',
    }

    const name = names[algorithm] ?? algorithm.toUpperCase()
    const encoded = new TextEncoder().encode(data)
    const hash = await crypto.subtle.digest(name, encoded)

    return Array.from(new Uint8Array(hash))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
  },
  randomBytes: (size: number): Uint8Array =>
    crypto.getRandomValues(new Uint8Array(size)),
}
