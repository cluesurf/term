// A `find` names something the module it loads defines.
//
// `find get` from `@term/base/network/http` still compiled after the module stopped defining a `get` of its own, and
// `wait get(url)` built and failed at run time with `ReferenceError: get is not defined` (guides:
// applications/web/fetching, 2026-10-03). A stale import was the same as no import, with no message, and the flat
// merge then bound the name to whatever else in the program had it.
//
// For each `find` in the file being compiled: the name is defined in one of the files the load resolved to, or in a
// file one of those re-exports through `bear`. "Defined" is read two ways, either enough: a top-level statement of the
// built program (a task, a form or one of its variants, a bind, a native alias, a mask, a view, a constant), or a
// top-level line of the module's own source naming it (a `tree` or `fuse` template expands before the program is
// built, so it is never a statement).

import { existsSync, readFileSync } from 'node:fs'
import type { Program } from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { ImportScope } from '@term/make/code/compile/load'

// the language's own type words, which a `find` may name and no module defines, and the kind words a `find` may lead
// with (`find tree checked-add`, `find form size-32`), where the import scope records the kind and not the name
const BUILT_IN = new Set([
  'tree',
  'fuse',
  'bind',
  'mask',
  'view',
  'rule',
  'text',
  'number',
  'integer',
  'float',
  'decimal',
  'boolean',
  'list',
  'hash',
  'bytes',
  'void',
  'unknown',
  'dynamic',
  'type',
  'task',
  'form',
])

// the suffix module scope gives each file's definition of a name two files define
const SPLIT = /__in\d+_\d+$/

// a module's own name: its file's, or its directory's for a `base.tree` or `note.tree` entry
function moduleName(file: string): string {
  const parts = file.split('/')
  const leaf = (parts.at(-1) ?? '').replace(/\.tree$/, '')

  return leaf === 'base' || leaf === 'note' ? (parts.at(-2) ?? leaf) : leaf
}

const DEFINING =/^(?:task|form|bind|host|tree|fuse|mask|view|rule|mill|suit|list|mesh|save|mine|mint)\s+([^\s,]+)/

export function checkFinds(program: Program, file: string, scope: ImportScope | undefined): Diagnostic[] {
  const own = scope?.get(file)

  if (!own || own.finds.size === 0) {
    return []
  }

  // what each file defines, from the program
  const defined = new Map<string, Set<string>>()
  const add = (where: string | undefined, name: string | undefined): void => {
    if (!where || !name) {
      return
    }

    const names = defined.get(where) ?? new Set<string>()
    names.add(name)
    // a form or task two files define is split by file before this runs (`point__in0_0`, check/scope.ts and
    // check/overload.ts), so it is defined under the name it was written with too
    names.add(name.replace(SPLIT, ''))
    defined.set(where, names)
  }

  for (const s of program) {
    const where = s.span?.file
    const record = s as { name?: string; alias?: string; method?: { name: string } }

    if (s.form === 'record-type') {
      add(where, s.name)

      for (const variant of s.variants) {
        add(where, variant.name)
      }
    } else if (s.form === 'native') {
      add(where, record.alias)
    } else if (s.form === 'let') {
      add(where, s.name)
    } else if (record.method) {
      // a form's method is found by its bare name: `find size` from list.tree reaches `form list`'s `task size`
      add(where, record.method.name)
      add(where, record.name)
    } else if (record.name) {
      add(where, record.name)
    }
  }

  // and from the source, for what is gone by the time the program is built
  const sourceNames = new Map<string, Set<string>>()
  const readSource = (target: string): Set<string> => {
    const cached = sourceNames.get(target)

    if (cached) {
      return cached
    }

    const names = new Set<string>()

    if (existsSync(target)) {
      for (const line of readFileSync(target, 'utf8').split('\n')) {
        const match = DEFINING.exec(line)

        if (match) {
          names.add(match[1]!)
        }

        // a dock alias (`load <node:fs>, name fs`) and a `find ..., name alias` are names the module exposes too
        const alias = /^\s+(?:load|find)\s.*,\s*name\s+([^\s,]+)/.exec(line)

        if (alias) {
          names.add(alias[1]!)
        }
      }
    }

    sourceNames.set(target, names)

    return names
  }

  // a name is reachable from a file when it defines it, or a file it bears does
  const reaches = (target: string, name: string, seen: Set<string>): boolean => {
    if (seen.has(target)) {
      return false
    }

    seen.add(target)

    if (defined.get(target)?.has(name) || readSource(target).has(name)) {
      return true
    }

    const entry = scope?.get(target)

    for (const borne of entry?.bears ?? []) {
      if (reaches(borne, name, seen)) {
        return true
      }
    }

    // a module that re-finds the name (`load x / find name` then exposes it) passes it on
    for (const found of entry?.finds.get(name) ?? []) {
      if (reaches(found, name, seen)) {
        return true
      }
    }

    return false
  }

  const out: Diagnostic[] = []

  for (const [name, targets] of own.finds) {
    // a built-in type's name needs no import, and `find text` from text.tree names the type its tasks are about. So
    // does any module's own name, `find time` from time.tree or `find hash` from hash/base.tree: the idiom for "this
    // module", which names no definition and never did
    if (
      BUILT_IN.has(name) ||
      targets.length === 0 ||
      targets.some(target => moduleName(target) === name || reaches(target, name, new Set()))
    ) {
      continue
    }

    const span: Span = own.at?.get(name) ?? program.find(s => s.span?.file === file)?.span ?? {
      file,
      start: { line: 0, column: 0 },
      end: { line: 0, column: 0 },
    }

    out.push(
      diagnose('unknown-name', {
        file,
        span,
        message: `"${name}" is found in ${targets.map(t => t.split('/').slice(-2).join('/')).join(', ')}, which does not define it`,
        hint: 'remove the `find`, or load the module that defines the name now',
      }),
    )
  }

  return out
}
