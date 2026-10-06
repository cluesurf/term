// The package name a `deck.tree` declares, read with the real parser.
//
// There is ONE parser for `.tree` in this codebase. This used to be a regex anchored on a `deck` line, in two places, which is
// a second, worse implementation of the grammar: it reads a `deck` line inside a comment or a text literal as the
// declaration, it cannot see a name written with an interpolation, and it silently disagrees with the compiler about
// what the file says. That is the same shape of bug that made `deck/make/code/compile/load.ts` drop a file's imports
// when a comment held one bare `<`.
//
// A `deck.tree` is a MANIFEST when a top-level `deck` head carries an `@scope/name`. The stdlib also has a code
// module called deck.tree (`form deck`, the manifest's own shape), which has no such statement and correctly reads
// as undefined here.
//
// Every reading of a parsed file is Term since 2026-10-06, call/code/manifest-read.tree, with the reasons each rule is
// what it is. This file reads the files, and answers undefined where the port answers none or a read fails.

import { readFileSync } from 'node:fs'
import * as port from '@term/call/code/manifest-read'

const given = (value: port.Maybe<string>): string | undefined => (value.form === 'some' ? value.value : undefined)

// the first argument of a manifest's `<head>` statement (`deck @term/site` -> `@term/site`, `role ./roles` ->
// `./roles`), or undefined when the manifest has none. It is found under the `deck` statement first, then at the top
// level. test/compile/host-tools.ts holds the nested case
export function manifestValue(
  text: string,
  file: string,
  head: string,
): string | undefined {
  return given(port.manifestValue(text, file, head))
}

// the same, read from a file. Unreadable or unparseable is undefined, the way a missing manifest is.
export function manifestValueOf(
  file: string,
  head: string,
): string | undefined {
  try {
    return manifestValue(readFileSync(file, 'utf8'), file, head)
  } catch {
    return undefined
  }
}

// the name a manifest declares: the argument of its TOP-LEVEL `deck` statement, `@scope/name` or a bare `name`.
//
// It required an `@` until 2026-10-02, and that was the bug: `term wake hello` writes `deck hello`, so `term make`
// did not see a manifest, compiled the scaffold's deck.tree as CODE into host/deck.ts, and reported "Compiled 2
// files" for a project holding one.
export function manifestName(text: string, file: string): string | undefined {
  return given(port.manifestName(text, file))
}

export function manifestNameOf(file: string): string | undefined {
  try {
    return manifestName(readFileSync(file, 'utf8'), file)
  } catch {
    return undefined
  }
}

// Is this file a LOCKFILE (`lock <1>` and one `deck` entry per resolved package), as opposed to Term code?
//
// The lockfile is written by `term save` / `term toss` / `term link` — anything that installs — and it is data,
// not code. The build compiled it, and `lock <version>` is not a Term statement, so the first `term make` after
// any dependency verb failed with `the name "lock" is not defined` on a file the user never wrote. BY CONTENT, never
// by name: `deck/base/code/task/lock.tree` is an ordinary Term module.
export function isLockfileText(text: string, file: string): boolean {
  return port.isLockfileText(text, file)
}

// Is this file a ROLE FILE (`role <name>` with `take` globs), as opposed to Term code?
//
// A role file says which mill reads which file, and -- for `hook` -- whether a file's statements are CLI commands
// or URL routes. It is configuration read by deck/deck/code/role.ts through the role mill, not a program. BY CONTENT,
// never by name: `role.tree` is a strong hint and nothing more, and this package's own role file is `role/base.tree`.
export function isRoleFileText(text: string, file: string): boolean {
  return port.isRoleFileText(text, file)
}

// the same, read from a file
export function isRoleFileAt(file: string): boolean {
  try {
    return isRoleFileText(readFileSync(file, 'utf8'), file)
  } catch {
    return false
  }
}

// the same, read from a file
export function isLockfileAt(file: string): boolean {
  try {
    return isLockfileText(readFileSync(file, 'utf8'), file)
  } catch {
    return false
  }
}
