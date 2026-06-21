// Raw byte buffers over the Web platform. The currency value is a Uint8Array. There is no Buffer, so hex is done by
// hand and base64 goes through atob / btoa. Text is utf8 via TextEncoder / TextDecoder.
const octets = {
  fromText: (text: string): Uint8Array => new TextEncoder().encode(text),
  toText: (value: Uint8Array): string => new TextDecoder().decode(value),
  toHex: (value: Uint8Array): string =>
    Array.from(value).map((b) => b.toString(16).padStart(2, '0')).join(''),
  fromHex: (text: string): Uint8Array => {
    const out = new Uint8Array(text.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16)
    return out
  },
  toBase64: (value: Uint8Array): string => btoa(String.fromCharCode(...value)),
  fromBase64: (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
  length: (value: Uint8Array): number => value.length,
  concat: (left: Uint8Array, right: Uint8Array): Uint8Array => {
    const out = new Uint8Array(left.length + right.length)
    out.set(left, 0)
    out.set(right, left.length)
    return out
  },
  slice: (value: Uint8Array, start: number, end: number): Uint8Array => value.slice(start, end),
}
