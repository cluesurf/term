// Runtime shim for server-side resource proxying: fetch an external URL and return its bytes as base64. Provided via
// <global:net> (docked `name web` -> `const web = net`), so a proxy resource route (e.g. /vibe.pdf) streams the
// canonical asset through the app's own origin -- the URL stays on the app (no redirect), exactly like the React
// loader's `new Response(fetch(...).body)`. base64 because the `.tree` response body is text; the transport recognises
// the binary extension (pdf, etc.) and decodes it back to bytes with the right content-type.

export const net = {
  async fetchBytes(url: string): Promise<string> {
    const response = await fetch(url)
    const buffer = Buffer.from(await response.arrayBuffer())

    return buffer.toString('base64')
  },
}
