// pnpm term:scope-census [--only <package>] [--list]
//
// module-scope-0001: what the compiler's one flat program is relied on for, per package. For each package under
// deck, its platform-independent .tree files (drafts aside, and nothing under a `native/`
// directory) are loaded through one synthetic entry, ONCE PER ENV (node, browser, macos, android, rust), so each env's
// `{platform}` slots pull in that env's hosts and no others. A per-platform alternative (the five dom hosts, the
// per-language db) never shares a program with its siblings in a real build, and loading them all at once reported
// every one of them as a collision. check/scope-census.ts counts, over the package's OWN files, the union over envs:
//
//   collisions    names defined in two or more files of the program, by namespace (value: tasks, components, host
//                 constants; type: forms, masks)
//   unimported    references their file neither defines nor imports, so only the global merge resolves them
//
// A file that does not parse or mill is listed and left out, never dropped in silence. --list prints every
// unimported reference with its file; without it, the counts and the most frequent names. Reports only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { isLookStylesheet } from '@term/make/code/compile/compile'
import { collectModules, makeParseMemo } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { scopeCensus } from '@term/make/code/check/scope-census'
import type { Collision, Unimported } from '@term/make/code/check/scope-census'
import type { Program } from '@term/make/code/compile/node'
import type { Source } from '@term/make/code/compile/load'
import { millFormReferences, millLoadTargets } from '@term/make/code/compile/mill-check'
import { buildable, projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { TERM_ROOT } from './root'

export const REPO = TERM_ROOT
export const TERM = TERM_ROOT
export const DECKS = join(TERM, 'deck')
const SKIP_DIRS = new Set(['node_modules', 'host', '.base', 'tmp', 'test', 'link'])

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
const list = args.includes('--list')

// a file shelved out of the build: `mark draft` (or the old `note draft`) near its top, or a `draft.tree` in its directory or above it
function drafted(file: string, top: string): boolean {
  const head = readFileSync(file, 'utf8').split('\n').slice(0, 12)

  if (head.some(line => line.trim() === 'mark draft' || line.trim() === 'note draft')) {
    return true
  }

  for (let dir = dirname(file); dir.startsWith(top); dir = dirname(dir)) {
    if (existsSync(join(dir, 'draft.tree'))) {
      return true
    }

    if (dir === top) {
      break
    }
  }

  return false
}

function treeFiles(dir: string, top: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.endsWith('-cache') || name.startsWith('.')) {
      continue
    }

    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      treeFiles(path, top, into)
    } else if (name.endsWith('.tree') && name !== 'deck.tree' && name !== 'lock.tree' && name !== 'role.tree' && !drafted(path, top)) {
      into.push(path)
    }
  }

  return into
}

const ENVS = ['node', 'browser', 'macos', 'android', 'rust'] as const
const roleOf = projectRoleOf(TERM)
const leanOf = projectLeanOf(TERM)
const memo = makeParseMemo()
const short = (file: string) => relative(DECKS, file)

const packages = readdirSync(DECKS)
  .filter(name => existsSync(join(DECKS, name, 'deck.tree')) && existsSync(join(DECKS, name, 'code')))
  .filter(name => !only || name === only)
  .sort()

let totalCollisions = 0
let totalUnimported = 0
let totalShadowed = 0

// the files defining each FORM-namespace name of a program (a form, a mask, a dock type), as check/census.tree
// `defined` reads them: what a grammar's form reference is counted against
function typeDefiners(program: Program): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (name: string, file: string | undefined) => {
    if (file) {
      out.set(name, (out.get(name) ?? new Set()).add(file))
    }
  }

  for (const one of program) {
    if (one.form === 'record-type' || one.form === 'mask') {
      add(one.name, one.span.file)
    } else if (one.form === 'native' && (one as { kind?: unknown }).kind === 'type') {
      add(one.alias, one.span.file)
    }
  }

  return out
}

// one env's program for a package: its platform-independent files and everything they reach under that env.
// Decision 003 of note/project/term/module-scope, rule 1: the files are read as the build reads them. A `mill`-role
// grammar file is no Term program, so it is never milled here: its references are the forms its mints hand to Term,
// read by compile/mill-check.ts (`grammar`), the one reader of grammar files. A feed grammar (a `mine.tree` the build
// turns into a generated reader, call/code/make.ts `buildable`) is not a program as written either, and is left out
function programFor(top: string, files: string[], env: (typeof ENVS)[number], broken: Set<string>) {
  const resolver = withNativeEnv(env, projectResolver(TERM, env))
  const entryFile = join(top, 'scope-census-entry.tree')
  const entryText = files.map(file => `load ./${relative(top, file).replace(/\.tree$/, '')}`).join('\n')
  const { sources, scope } = collectModules({ file: entryFile, text: entryText }, resolver, memo)
  const program: Program = []
  const grammar: { unit: Source; loads: { target: string; found?: Source }[] }[] = []

  for (const unit of sources) {
    if (unit.file === entryFile) {
      continue
    }

    const role = roleOf(unit.file)

    if (role === 'mill') {
      const loads = millLoadTargets(unit).map(target => {
        let found: Source | undefined

        try {
          found = target ? resolver(target, unit.file) ?? undefined : undefined
        } catch {
          found = undefined
        }

        return found ? { target, found } : { target }
      })

      grammar.push({ unit, loads })
      continue
    }

    const read = buildable(unit.file, unit.text, role)

    if (!('text' in read) || read.generated) {
      continue
    }

    const parsed = memo(unit)

    if (!parsed.ok) {
      broken.add(`${short(unit.file)}: does not parse`)
      continue
    }

    // a look sheet compiles to a stylesheet, never into the program (compile.ts), so its words are no references
    if (isLookStylesheet(unit)) {
      continue
    }

    const built = mill(expandTemplates(parsed.tree), unit.file, roleOf(unit.file) ?? undefined, leanOf(unit.file))

    if (!built.ok) {
      broken.add(`${short(unit.file)}: does not mill (${built.diagnostics[0]?.message ?? '?'})`)
      continue
    }

    // the file a statement came from, stamped as the compile stamps it (compile.ts), which is what the census keys on
    for (const node of built.program) {
      node.span.file = unit.file
    }

    program.push(...built.program)
  }

  // a grammar's form reference no find reaches, counted as the Term walk counts one: only when the program defines it
  const definers = typeDefiners(program)
  const grammarUnimported: Unimported[] = []

  for (const { unit, loads } of grammar) {
    for (const ref of millFormReferences(unit, loads)) {
      const by = definers.get(ref.name)

      if (!ref.found && by && by.size > 0) {
        grammarUnimported.push({ namespace: 'type', name: ref.name, file: unit.file, definers: [...by].sort() })
      }
    }
  }

  return { program, scope, sources: sources.map(s => s.file), grammarUnimported }
}

// one package's census, the union over ENVS. term:find-migrate (task/term/find-migrate.ts) reads the same answer
export function packageCensus(name: string) {
  const top = join(DECKS, name)
  const files = treeFiles(join(top, 'code'), top)
  // a per-platform host arrives through its env's `{platform}` slot, never loaded beside its siblings
  const portable = files.filter(file => !relative(top, file).split('/').includes('native'))
  const broken = new Set<string>()
  const collisionsByKey = new Map<string, Collision>()
  const unimportedByKey = new Map<string, Unimported>()
  const shadowedByKey = new Map<string, Unimported>()
  const reached = new Set<string>()

  for (const env of ENVS) {
    const { program, scope, sources, grammarUnimported } = programFor(top, portable, env, broken)
    sources.forEach(file => reached.add(file))
    const own = new Set(files)
    const census = scopeCensus(program, scope, file => !own.has(file))

    for (const ref of grammarUnimported.filter(r => own.has(r.file))) {
      unimportedByKey.set(`${ref.file} ${ref.namespace} ${ref.name}`, ref)
    }

    for (const collision of census.collisions.filter(c => c.files.some(f => own.has(f)))) {
      collisionsByKey.set(`${collision.namespace} ${collision.name} ${collision.files.join(',')}`, collision)
    }

    for (const ref of census.unimported) {
      unimportedByKey.set(`${ref.file} ${ref.namespace} ${ref.name}`, ref)
    }

    for (const ref of census.shadowed) {
      shadowedByKey.set(`${ref.file} ${ref.namespace} ${ref.name}`, ref)
    }
  }

  // a package file no env's program reached: a per-platform host for an env not in ENVS, or a file nothing loads
  const unreached = files.filter(file => !reached.has(file))

  return {
    files,
    collisions: [...collisionsByKey.values()],
    unimported: [...unimportedByKey.values()],
    shadowed: [...shadowedByKey.values()],
    broken,
    unreached,
  }
}

const direct = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

for (const name of direct ? packages : []) {
  const { files, collisions, unimported, shadowed, broken, unreached } = packageCensus(name)
  const census = { unimported, shadowed }
  totalShadowed += census.shadowed.length
  totalCollisions += collisions.length
  totalUnimported += census.unimported.length

  console.log(`\n== ${name}: ${files.length} files, ${collisions.length} collisions, ${census.unimported.length} unimported references, ${census.shadowed.length} method calls a foreign task can shadow`)

  for (const collision of collisions) {
    console.log(`   collision ${collision.namespace} ${collision.name}: ${collision.files.map(short).join(', ')}`)
  }

  if (list) {
    for (const ref of census.unimported) {
      console.log(`   unimported ${ref.namespace} ${ref.name} in ${short(ref.file)} (defined in ${ref.definers.map(short).join(', ')})`)
    }

    for (const ref of census.shadowed) {
      console.log(`   shadowed ${ref.name} in ${short(ref.file)} (a method, and a task in ${ref.definers.map(short).join(', ')})`)
    }
  } else {
    const byName = new Map<string, number>()
    census.unimported.forEach(ref => byName.set(`${ref.namespace} ${ref.name}`, (byName.get(`${ref.namespace} ${ref.name}`) ?? 0) + 1))
    const top20 = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 20)

    if (top20.length) {
      console.log(`   most unimported: ${top20.map(([key, n]) => `${key} ${n}`).join(', ')}`)
    }
  }

  for (const line of broken) {
    console.log(`   left out: ${line}`)
  }

  if (unreached.length) {
    console.log(`   not reached by any of ${ENVS.join(', ')}: ${unreached.length} files${list ? `\n     ${unreached.map(short).join('\n     ')}` : ''}`)
  }
}

if (direct) {
  console.log(`\nscope-census: ${packages.length} packages, ${totalCollisions} collisions, ${totalUnimported} unimported references, ${totalShadowed} method calls a foreign task can shadow`)
}
