// `crypto` for the browser compile: the bundle aliases `crypto` and `node:crypto` here. The compiler's ports are
// emitted for node, and their digest (@term/base/cryptography/digest, the hash keys of cache-store, unit-mill,
// program-driver and hold-walk) calls `createHash(algorithm).update(input).digest(encoding)`. Nothing else of Node's
// `crypto` is on the compile path.
//
// Every decision is Term, browser/digest.tree, over native/shared/cryptography, the definitions node's own digest is
// held equal to. This file is only Node's shape: `update` takes a string (as UTF-8) or bytes and chains, and `digest`
// answers hex for `'hex'` and bytes with no encoding. An algorithm with no Term definition (sha512) throws when
// called, as absent.ts does.

import * as port from '@term/call/code/browser/digest'

const HEX: Record<string, (input: number[]) => string> = {
  sha256: port.sha256Hex,
  md5: port.md5Hex,
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let at = 0; at < out.length; at++) {
    out[at] = parseInt(hex.slice(at * 2, at * 2 + 2), 16)
  }
  return out
}

export function createHash(algorithm: string) {
  const hex = HEX[algorithm]
  if (!hex) {
    throw new Error(`\`createHash('${algorithm}')\` is a Node builtin, and the browser compile has no Node`)
  }
  const bytes: number[] = []
  const hasher = {
    update(input: string | Uint8Array) {
      const more = typeof input === 'string' ? port.textBytes(input) : input
      for (const byte of more) {
        bytes.push(byte)
      }
      return hasher
    },
    digest(encoding?: string): string | Uint8Array {
      const answer = hex(bytes)
      if (encoding === 'hex') {
        return answer
      }
      if (encoding === undefined) {
        return hexBytes(answer)
      }
      throw new Error(`\`digest('${encoding}')\` is a Node builtin, and the browser compile has no Node`)
    },
  }
  return hasher
}

export default { createHash }
