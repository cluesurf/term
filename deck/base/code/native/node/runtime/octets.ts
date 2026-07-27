// Raw byte buffers over the node host. The currency value is a Uint8Array. Buffer is a Uint8Array subclass, so the
// node hex and base64 codecs come for free with zero copy at the boundary.
const octets = {
  fromText: (text: string): Uint8Array =>
    new TextEncoder().encode(text),
  toText: (value: Uint8Array): string =>
    new TextDecoder().decode(value),
  toHex: (value: Uint8Array): string =>
    Buffer.from(value).toString('hex'),
  fromHex: (text: string): Uint8Array =>
    new Uint8Array(Buffer.from(text, 'hex')),
  toBase64: (value: Uint8Array): string =>
    Buffer.from(value).toString('base64'),
  fromBase64: (text: string): Uint8Array =>
    new Uint8Array(Buffer.from(text, 'base64')),
  length: (value: Uint8Array): number => value.length,
  concat: (left: Uint8Array, right: Uint8Array): Uint8Array => {
    const out = new Uint8Array(left.length + right.length)
    out.set(left, 0)
    out.set(right, left.length)
    return out
  },
  slice: (value: Uint8Array, start: number, end: number): Uint8Array =>
    value.slice(start, end),
}
