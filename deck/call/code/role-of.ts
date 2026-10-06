// The role a project gives a file: its `role.tree` maps globs to mill names (`role host` / `take @/data/**/*.tree`),
// and the build passes the answer to the compiler so a file's role can override what its content says. The file
// sits at the project root, or where the manifest's `role <dir>` points. Read once per build; a project without one
// answers null for every file, and content decides.

import { existsSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { parseRoleFile, matchRoleRule } from '@cluesurf/deck.tree'
import type { RoleConfig, RoleRule } from '@cluesurf/deck.tree'
import { manifestValueOf } from '@term/call/code/manifest-name'
import * as port from '@term/call/code/role-check'

export type RoleOf = (file: string) => string | null

// The package a file belongs to: its nearest ancestor holding a `deck.tree`, else the project root.
//
// This is what makes a role file PER PACKAGE. A build pulls in a dependency's source, and that source is written
// against its OWN package's conventions: @term/site says its `code/test/site/route.tree` holds routes, and no
// project that depends on it should have to know or repeat that. Reading one role file at the build root gave a
// dependency's files the ROOT project's rules, which are about the root project's layout and say nothing true
// about the dependency's.
//
// It also makes `@` mean the right thing. A glob's `@` is the package root, so `@/code/**` in @term/site's role
// file has to expand against @term/site's directory, not against whoever is building.
function packageRootOf(file: string, root: string): string {
  let dir = path.dirname(file)

  for (;;) {
    if (existsSync(path.join(dir, 'deck.tree'))) {
      return dir
    }

    const up = path.dirname(dir)

    if (up === dir || dir.length <= root.length) {
      return root
    }

    dir = up
  }
}

export function projectRoleOf(root: string): RoleOf {
  const ruleOf = projectRuleOf(root)

  return file => ruleOf(file)?.name ?? null
}

/**
 * Whether a file's role rule carries `mark lean`: the files it matches are read with the lean surface, where a
 * bare head is a call and a property head is a named argument. See note/term/lean.md.
 *
 * A SECOND FUNCTION over the same cache rather than a widened `RoleOf`, because every existing caller wants
 * the name and only the mill wants the flag.
 */
export function projectLeanOf(root: string): (file: string) => boolean {
  const ruleOf = projectRuleOf(root)

  return file => ruleOf(file)?.mark.includes('lean') ?? false
}

/**
 * The matched RULE for a file, cached per package and per file. Both of the above read it, so a build that asks
 * for the role and the lean flag reads the role files once, not twice.
 */
function projectRuleOf(root: string): (file: string) => RoleRule | null {
  // one role config per PACKAGE, read once. A build touches thousands of files across a handful of packages, so
  // the cache is on the package rather than on the file.
  const byPackage = new Map<string, RoleConfig | undefined>()
  const byFile = new Map<string, RoleRule | null>()

  return file => {
    const known = byFile.get(file)

    if (known !== undefined) {
      return known
    }

    const pkg = packageRootOf(file, root)

    if (!byPackage.has(pkg)) {
      byPackage.set(pkg, readRoles(pkg))
    }

    const config = byPackage.get(pkg)
    const rule =
      config && config.rules.length > 0
        ? matchRoleRule({ filePath: file, config })
        : null

    byFile.set(file, rule)

    return rule
  }
}

function readRoles(root: string): RoleConfig | undefined {
  // THE DEFAULT IS `base/role.tree`, and a package needs no `role` line in its manifest to have one. `role.tree`
  // at the root is kept as a second default so a small project can put it there without a `base/` at all.
  //
  // A manifest that DOES declare `role <path>` wins over both, and is unshifted in front below.
  const candidates = [
    path.join(root, 'base', 'role.tree'),
    path.join(root, 'role.tree'),
  ]
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
      return checkedRoles(candidate, root)
    }
  }

  return undefined
}

// A role file that cannot be read, or that names a role the compiler does not have, STOPS THE BUILD, naming the file.
// A misspelled `role hots` over data files built them as code with no warning, and a line the role grammar refused
// dropped the whole file, every file then falling back to its content (guides: language/dsls/roles, 2026-10-03). Both
// checks, and the roles there are, are Term since 2026-10-06, call/code/role-check.tree
function checkedRoles(file: string, root: string): RoleConfig {
  let config: RoleConfig
  const text = readFileSync(file, 'utf8')

  // a rule's flag is `mark <word>`, and a `note` there is read by nothing
  const note = port.noteProblem(text, file)

  if (note !== '') {
    throw new Error(note)
  }

  try {
    config = parseRoleFile({ text, root })
  } catch (cause) {
    throw new Error(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const unknown = port.roleProblem(config.rules.map(rule => rule.name), file)

  if (unknown !== '') {
    throw new Error(unknown)
  }

  return config
}
