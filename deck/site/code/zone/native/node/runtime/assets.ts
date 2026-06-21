// Runtime shim for serving static assets (node): read a file for a `/base/<path>` request URL from the build output.
// Provided via <global:assets>; the build prepends it next to the node host that docks it (`name files` -> `const
// files = assets`, so the host calls `files.read`). The exported NAMESPACE is `assets` (an object), distinct from any
// task name and not a reserved word. The host's `/base/**` route calls it; the transport sets the content-type by
// extension. Returns `{ found, body }` (text), so the `.tree` side never expresses fs / path. Assets live under
// `<cwd>/build/` (the `seed make` output); `/base/X` maps to `build/X`. Path traversal is stripped.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

export const assets = {
  read(urlPath: string): { found: boolean; body: string } {
    const rel = urlPath.replace(/^\/+base\/+/, '')
    // strip any leading `../` so a request cannot escape the build dir
    const safe = normalize(rel).replace(/^(\.\.([/\\]|$))+/, '')

    if (!safe || safe === '.') {
      return { found: false, body: '' }
    }

    const file = join(process.cwd(), 'build', safe)

    try {
      if (existsSync(file) && statSync(file).isFile()) {
        return { found: true, body: readFileSync(file, 'utf8') }
      }
    } catch {
      // unreadable -> not found
    }

    return { found: false, body: '' }
  },
}
