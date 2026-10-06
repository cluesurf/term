// The package-manager install: resolve a project's dependencies, fetch them into the content-addressed store,
// link them into the project, and write the lockfile. End to end against a registry (a directory of packages; the
// network registry is a swappable source). Node-only (filesystem), runs at build/install time, not in the browser.
// See note/research/vibe/computation/plans/16-package-manager.md.
//
// The install is Term, deck/installing.tree (self-hosting, 2026-10-06): reading a manifest, picking a version,
// resolving the dependencies depth first, and the lockfile. This face is the disk and the hash: each read, listing,
// copy, link and write the Term side asks for, and sha512 by node's crypto.

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Lockfile } from '@term/make/code/deck/lock'
import * as installing from '@term/make/code/deck/installing'

export type Manifest = {
  name: string
  version: string
  deps: { name: string; range: string }[]
}

export function parseDeck(text: string): Manifest {
  return installing.parseDeck(text)
}

export type InstallResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; error: string }

const disk = {
  readFile: (path: string): string => readFileSync(path, 'utf8'),
  exists: existsSync,
  readDir: (path: string): string[] => readdirSync(path),
  makeDirs: (path: string): void => {
    mkdirSync(path, { recursive: true })
  },
  copyTree: (from: string, to: string): void => cpSync(from, to, { recursive: true }),
  removeTree: (path: string): void => rmSync(path, { recursive: true, force: true }),
  linkTo: (target: string, path: string): void => symlinkSync(target, path),
  writeFile: (path: string, text: string): void => writeFileSync(path, text),
  sha512Hex: (text: string): string => createHash('sha512').update(text).digest('hex'),
}

// install a project's dependencies. registryDir holds <host>/<deck>/<version>/ packages; storeHome is the
// content-addressed store root (the ~/.base/@term/code equivalent, parameterized for testing).
export function install(
  projectDir: string,
  registryDir: string,
  storeHome: string,
): InstallResult {
  const answer = installing.install(disk, projectDir, registryDir, storeHome)

  return answer.form === 'installed' ? { ok: true, lockfile: answer.lockfile as Lockfile } : { ok: false, error: answer.error }
}
