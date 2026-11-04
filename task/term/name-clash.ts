/**
 * Which form NAMES are declared more than once inside one Term package?
 *
 * Term names are PACKAGE-GLOBAL. Two modules that both write `form show-ask`
 * do not get two forms: the checker's record table is keyed on the name alone,
 * so whichever module is read second decides what the name means for the whole
 * package, and every construction of the other one is silently typed against
 * fields it does not have.
 *
 * The failure surfaces in a THIRD file and names neither of the two. That is
 * what happened in `@term/call` on 2026-09-13: `roll.tree` and
 * `base-verbs.tree` each declared `show-ask`, and the error arrived as
 * `"show-ask" has no field "root"` pointing at `line/base.tree`, which declares
 * nothing. Five names in that one package had collided the same way and none of
 * them had ever been reported, because nothing asked.
 *
 * Most of what this finds is DELIBERATE: the stdlib declares `boolean` in
 * `code/boolean.tree` and again in `code/native/javascript/boolean.tree`,
 * because only one of the two is ever in a given target's module closure. So
 * this REPORTS and is not a gate. Read it as a list of places where two
 * declarations could reach one program, and check each.
 *
 *   pnpm term:name-clash              every package
 *   pnpm term:name-clash call seed    named packages only
 *
 * Reports only. It writes nothing, ever.
 *
 * Read with the compiler's parser and never with a line regex: there is ONE
 * parser for `.tree` (note/project/term/one-parser.md), and a regex over lines reads a
 * `form x` inside a `text <...>` literal or a `#` comment as a declaration.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { TERM_ROOT } from './root'

const DECK =
  `${TERM_ROOT}/deck`

// build output, installed packages, caches and scratch: none of them is source
const SKIP = new Set(['host', 'node_modules', '.base', 'tmp', '.git'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) {
      continue
    }

    const at = join(dir, name)

    if (statSync(at).isDirectory()) {
      walk(at, out)
    } else if (name.endsWith('.tree')) {
      out.push(at)
    }
  }

  return out
}

// the head name of a group
function head(group: GroupNode): string | undefined {
  const first = group.nodes[0]

  return first?.kind === 'name' ? renderHead(first) : undefined
}

// A top-level `form <name>` DECLARES that name. `form <name>` carrying terms on
// the same line is the same declaration with its generics; what is not a
// declaration is a `like <name>`, which never has `form` as its head.
function declaredIn(file: string): string[] {
  const parsed = parse({ file, text: readFileSync(file, 'utf8') })

  if (!parsed.ok) {
    return []
  }

  const names: string[] = []

  for (const node of parsed.tree.nodes) {
    if (node.kind !== 'group' || head(node) !== 'form') {
      continue
    }

    // a shelved module is out of the build, so its names cannot collide
    const name = node.nodes[1]

    if (name?.kind === 'group') {
      const spelled = head(name)

      if (spelled) {
        names.push(spelled)
      }
    }
  }

  return names
}

// `mark draft` (or the old `note draft`) at the top level shelves the whole file out of the build
function shelved(file: string): boolean {
  const parsed = parse({ file, text: readFileSync(file, 'utf8') })

  if (!parsed.ok) {
    return false
  }

  for (const node of parsed.tree.nodes) {
    if (node.kind !== 'group' || (head(node) !== 'note' && head(node) !== 'mark')) {
      continue
    }

    const what = node.nodes[1]

    if (what?.kind === 'group' && head(what) === 'draft') {
      return true
    }
  }

  return false
}

function main(): void {
  const asked = process.argv.slice(2).filter(one => !one.startsWith('-'))
  const packages = readdirSync(DECK)
    .filter(name => statSync(join(DECK, name)).isDirectory())
    .filter(name => asked.length === 0 || asked.includes(name))
    .sort()

  let total = 0

  for (const pkg of packages) {
    const where = new Map<string, string[]>()

    for (const file of walk(join(DECK, pkg))) {
      if (shelved(file)) {
        continue
      }

      for (const name of declaredIn(file)) {
        const seen = where.get(name)
        seen ? seen.push(file) : where.set(name, [file])
      }
    }

    const clashes = [...where]
      .filter(([, files]) => files.length > 1)
      .sort((a, b) => a[0].localeCompare(b[0]))

    if (clashes.length === 0) {
      continue
    }

    console.log(`\n${pkg}`)

    for (const [name, files] of clashes) {
      total += 1
      console.log(`  ${name}  (${files.length})`)

      for (const file of files) {
        console.log(`    ${file.slice(DECK.length + 1)}`)
      }
    }
  }

  console.log(
    `\n${total} form name(s) declared more than once within one package`,
  )
}

main()
