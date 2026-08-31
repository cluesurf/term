// The role a project gives a file: its `role.tree` maps globs to mill names (`role host` / `take @/data/**/*.tree`),
// and the build passes the answer to the compiler so a file's role can override what its content says. The file
// sits at the project root, or where the manifest's `role <dir>` points. Read once per build; a project without one
// answers null for every file, and content decides.

import { existsSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { parseRoleFile, matchRole } from '@cluesurf/deck.tree'
import type { RoleConfig } from '@cluesurf/deck.tree'
import { manifestValueOf } from '@term/call/code/manifest-name'

export type RoleOf = (file: string) => string | null

export function projectRoleOf(root: string): RoleOf {
  const config = readRoles(root)

  if (!config || config.rules.length === 0) {
    return () => null
  }

  const byFile = new Map<string, string | null>()

  return file => {
    const known = byFile.get(file)

    if (known !== undefined) {
      return known
    }

    const role = matchRole({ filePath: file, config })
    byFile.set(file, role)

    return role
  }
}

function readRoles(root: string): RoleConfig | undefined {
  const candidates = [path.join(root, 'role.tree')]
  const manifestPath = path.join(root, 'deck.tree')

  if (existsSync(manifestPath)) {
    const declared = manifestValueOf(manifestPath, 'role')

    if (declared) {
      const at = path.resolve(root, declared)

      // A DIRECTORY RESOLVES THE WAY EVERY OTHER TERM PATH DOES: `<dir>.tree`, then `<dir>/base.tree`, then
      // `<dir>/note.tree`. Only `<dir>/role.tree` was tried, so this package's own `role ./role` pointing at
      // `role/base.tree` found NOTHING, and `readRoles` returned undefined: every file answered null and content
      // decided everything. The role system was inert here and said so to nobody.
      //
      // Spelled out rather than shared with `resolveTreeFile` in call/code/make.ts, which imports this module:
      // reaching back the other way would be a cycle. The order is the one in CLAUDE.md's file_resolution rules.
      if (existsSync(at) && statSync(at).isDirectory()) {
        candidates.unshift(
          path.join(at, 'role.tree'),
          path.join(at, 'base.tree'),
          path.join(at, 'note.tree'),
        )
      } else {
        candidates.unshift(at, `${at}.tree`)
      }
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return parseRoleFile({ text: readFileSync(candidate, 'utf8'), root })
    }
  }

  return undefined
}
