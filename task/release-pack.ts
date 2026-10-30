// How a staged platform payload becomes its tarball, one way for every platform: `pnpm term:release` packs the others
// with it, and the Windows step (task/release-windows.ts) packs windows-x64 with it once the machine has built the
// payload's native part. The file list goes in first, the secrets check runs over everything, then the tar.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileList } from '@term/call/code/need-load'

// a file name that holds a secret or a key, refused in a payload whatever folder it is in
export const SECRET_FILE = /^(\.env.*|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa).*|zone\.code\.tree|auth)$|\.(pem|key|p12|pfx|gpg|asc)$/

// The last check before a payload is packed: nothing under the staged `term/` (its `node_modules` fetched from npm
// included) is a `.base` cache, a `.env`, or a key file, and no file names the machine it was built on: the home
// folder's absolute path, which shows the builder's user name and folder layout. A hit stops the release, naming
// the file
export function refuseSecrets(root: string): void {
  const home = Buffer.from(os.homedir())
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.base' || entry.name === '.git') {
          found.push(at)
        } else {
          walk(at)
        }
      } else if (SECRET_FILE.test(entry.name)) {
        found.push(at)
      } else if (entry.isFile() && readFileSync(at).includes(home)) {
        found.push(`${at} (holds ${home.toString()})`)
      }
    }
  }

  walk(root)
  if (found.length > 0) {
    throw new Error(`the payload holds what is never published:\n${found.map(at => `  ${path.relative(root, at)}`).join('\n')}`)
  }
}

/**
 * Pack `<stage>/term` into `file`: its file list (`hash.tree`, every file with its sha256 and mode, inside the signed
 * layer, so an install shares what an installed version holds alike), the secrets check, then the tar. Answers the
 * tarball's digest and size.
 */
export function packPayload(input: { stage: string; file: string }): { digest: string; bytes: number } {
  const root = path.join(input.stage, 'term')

  writeFileList(root)
  refuseSecrets(root)
  // COPYFILE_DISABLE keeps macOS tar from writing `._` resource-fork entries into the archive
  execFileSync('tar', ['-czf', input.file, '-C', input.stage, 'term'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

  return { digest: `sha256:${createHash('sha256').update(readFileSync(input.file)).digest('hex')}`, bytes: statSync(input.file).size }
}
