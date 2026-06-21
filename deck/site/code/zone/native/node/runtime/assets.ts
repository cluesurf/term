// Runtime shim for serving static assets (node): read a file for a `/base/<path>` request URL from the build output.
// Provided via <global:assets>; the build prepends it next to the node host that docks it (`name files` -> `const
// files = assets`, so the host calls `files.read`). The exported NAMESPACE is `assets` (an object), distinct from any
// task name and not a reserved word. The host's `/base/**` route calls it; the transport sets the content-type by
// extension. Returns `{ found, body }` (text), so the `.tree` side never expresses fs / path. Assets live under
// `<cwd>/build/` (the `seed make` output); `/base/X` maps to `build/X`. Path traversal is stripped.
//
// BINARY assets (images / fonts / media) cannot ride a text body unchanged, so a binary file is read and returned as a
// base64 string; the transport recognises the same binary extensions and base64-decodes the body into a real byte
// buffer before sending. Text assets (css / js / json / svg / xml / txt) pass through as utf8. This keeps the `.tree`
// `response.body` a plain text field while still serving correct bytes for `/base/<name>.<ext>` images, fonts, media.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

// extensions whose bytes are not valid utf8 text: read + carry them as base64 (the transport decodes by the same set)
const BINARY = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'avif',
  'bmp',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'mov',
  'pdf',
  'wasm',
])

export const assets = {
  read(urlPath: string): { found: boolean; body: string } {
    const rel = urlPath.replace(/^\/+base\/+/, '')
    // strip any leading `../` so a request cannot escape the build dir
    const safe = normalize(rel).replace(/^(\.\.([/\\]|$))+/, '')

    if (!safe || safe === '.') {
      return { found: false, body: '' }
    }

    const file = join(process.cwd(), 'build', safe)
    const dot = safe.lastIndexOf('.')
    const ext = dot >= 0 ? safe.slice(dot + 1).toLowerCase() : ''

    try {
      if (existsSync(file) && statSync(file).isFile()) {
        return {
          found: true,
          body: BINARY.has(ext)
            ? readFileSync(file).toString('base64')
            : readFileSync(file, 'utf8'),
        }
      }
    } catch {
      // unreadable -> not found
    }

    return { found: false, body: '' }
  },
}
