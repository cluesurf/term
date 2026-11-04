// Every `like <name>` in the stdlib that names no form, enum, primitive, generic, mask or alias, per the checker's
// `unknown-type` warning (compiler-hygiene-0010). Compiles every non-shelved module under deck/base/code with its
// closure in its own native env (rust for native/rust, and so on), and counts each module's OWN sites, the way the
// per-module warning reports them. The count must stay at zero: a site here compiled clean and emitted a type the
// backend never defined.
//
//   pnpm term:unknown-types
//
// Shelved modules (`mark draft` in the file, or a `draft.tree` in an ancestor directory) are skipped and counted,
// matching the build walk. A module that fails to parse or mill is listed as failed, and fails the run. Exit 1 on
// any failure or any site.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve as resolvePath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@term/make/code/parser/tree'
import { stdlibResolver } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { bindModules, stampModule } from '@term/make/code/check/bind-modules'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import type { Statement } from '@term/make/code/compile/node'
import { TERM_ROOT } from './root'

const ROOT = TERM_ROOT
const TERM = TERM_ROOT
const SEED = join(TERM, 'deck/base')

// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
// and a relative path beside its importer
const stdlibOf = stdlibResolver()

const resolver = (path: string, from?: string): Source | undefined => {
  if (path.startsWith('@term/base')) {
    return stdlibOf?.(path, from ?? '')
  }

  if (!path.startsWith('.') || !from) {
    return undefined
  }

  const base = resolvePath(dirname(from), path)

  for (const file of [`${base}.tree`, join(base, 'base.tree')]) {
    if (existsSync(file)) {
      return { file, text: readFileSync(file, 'utf8') }
    }
  }

  return undefined
}

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (name.endsWith('.tree')) {
      into.push(path)
    }
  }

  return into
}

// the draft markers the build walk honors: `mark draft` (or the old `note draft`) in the file, `draft.tree` in an ancestor directory
const isDraft = (file: string, text: string): boolean => {
  if (/^(mark|note) draft$/m.test(text)) {
    return true
  }

  let dir = dirname(file)

  while (dir.startsWith(SEED)) {
    if (existsSync(join(dir, 'draft.tree'))) {
      return true
    }

    dir = dirname(dir)
  }

  return false
}

const envOf = (rel: string): 'node' | 'rust' | 'swift' | 'kotlin' =>
  rel.includes('native/rust/')
    ? 'rust'
    : rel.includes('native/swift/')
      ? 'swift'
      : rel.includes('native/kotlin/')
        ? 'kotlin'
        : 'node'

const byFile = new Map<string, string[]>()
const failures: string[] = []
let modules = 0
let shelved = 0
let sites = 0

for (const file of walk(join(SEED, 'code'))) {
  const rel = relative(SEED, file)
  const text = readFileSync(file, 'utf8')

  if (isDraft(file, text)) {
    shelved++
    continue
  }

  try {
    const { sources, scope } = collectModules(
      { file, text },
      withNativeEnv(envOf(rel), resolver),
    )
    const program: Statement[] = []
    let bad = ''

    for (const unit of sources) {
      const parsed = parse(unit)

      if (!parsed.ok) {
        bad = `parse: ${parsed.diagnostics[0]?.message ?? ''}`
        break
      }

      const built = mill(expandTemplates(parsed.tree), unit.file)

      if (!built.ok) {
        bad = `mill: ${built.diagnostics[0]?.message ?? ''}`
        break
      }

      stampModule(built.program, unit.file)
      program.push(...built.program)
    }

    if (bad) {
      failures.push(`${rel}  (${bad.slice(0, 120)})`)
      continue
    }

    // module scope and form extension, as `compileProgram` runs them (check/bind-modules.ts)
    bindModules(program, scope, file)
    resolveNames(program, file)
    const warnings = check(program, file).filter(
      d =>
        d.severity === 'warning' &&
        /is not a type this build knows/.test(d.message),
    )
    modules++

    for (const warning of warnings) {
      const name = /"([^"]+)"/.exec(warning.message)?.[1] ?? '?'
      byFile.set(rel, [...(byFile.get(rel) ?? []), name])
      sites++
    }
  } catch (error) {
    failures.push(`${rel}  (${String(error).slice(0, 120)})`)
  }
}

for (const [file, names] of [...byFile.entries()].sort()) {
  console.log(`${file} -> ${names.join(', ')}`)
}

for (const failure of failures) {
  console.log(`FAIL  ${failure}`)
}

console.log(
  `unknown-types: ${sites} sites across ${modules} modules, ${failures.length} failed to compile, ${shelved} shelved (skipped)`,
)

if (sites > 0 || failures.length > 0) {
  process.exit(1)
}
