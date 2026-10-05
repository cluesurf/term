// Interface stubs for separate compilation. A dependency unit's CHECKED program is reduced to the surface a
// dependent can observe: function signatures (bodies dropped, marked `stub`), record types, masks, instances,
// native / bind declarations, zones, and top-level lets. Private functions and top-level proof obligations are
// dropped (they belong to the owning unit). Dependents type-check against these stubs instead of the dependency's
// bodies, which is what makes a body-only dependency edit invisible to them (the early-cutoff firewall).
//
// Stubs are built from the checked (type-annotated) program, not the raw milled one, so parameter and result types
// the checker INFERRED are part of the surface a dependent sees, exactly matching `moduleInterface`'s fingerprint.

import type {
  Program,
  Statement,
} from '@term/make/code/compile/node'
import {
  lengthKeepingFunctions,
  purity,
  returnsFreshFunctions,
  stateFreeFunctions,
} from '@term/make/code/check/facts'
import { terminatingFunctions } from '@term/make/code/check/totality'
import { raiseSets } from '@term/make/code/check/effects'
import { EXCEPTION_FORM } from '@term/make/code/check/extend'
import { hashText } from '@term/make/code/term/hash'

// What the whole-program analyses found about each task of a checked unit, with every body in hand. A stub carries
// its own task's share (`stubFacts`, `stubWrites`, `stubRaises`), because a dependent has the stub and not the body,
// and every one of these analyses reads a callee's body: without them a separately compiled caller was refused what
// the merged build allowed (a twin of a task calling `count-each` read as impure, a guard's arm naming an exception
// a stdlib callee raises read as unreachable, a `have` the provers proved through a callee's purity left unproven)
export type StubKnown = {
  clean: Set<string>
  writes: Map<string, Set<number>>
  stateFree: Set<string>
  lengthKeeping: Set<string>
  returnsFresh: Set<string>
  ends: Set<string>
  raises: Map<string, Set<string>>
  native: Set<string>
}

export function stubKnown(program: Program): StubKnown {
  const pure = purity(program)
  const exceptions = new Set<string>()

  for (const s of program) {
    if (s.form === 'record-type' && s.chain?.includes(EXCEPTION_FORM)) {
      exceptions.add(s.name)
    }
  }

  const sets = raiseSets(program, exceptions)
  const clean = new Set<string>()

  for (const s of program) {
    if (s.form === 'function' && !pure.impure.has(s.name)) {
      clean.add(s.name)
    }
  }

  return {
    clean,
    writes: pure.writes,
    stateFree: stateFreeFunctions(program),
    lengthKeeping: lengthKeepingFunctions(program),
    returnsFresh: returnsFreshFunctions(program),
    ends: terminatingFunctions(program),
    raises: sets.raises,
    native: sets.native,
  }
}

// THE FINGERPRINT OF A UNIT'S SURFACE: its stubs, everything in them but where they were written. The stubs are the
// whole of what a dependent reads of this unit, so a dependent's cached build is valid exactly while this is
// unchanged. It was `interfaceHash`, a summary of names and types, which left out a task's contracts (`have`, `must`),
// its signature's raise bounds, a parameter's default, a constant's value (folded into a dependent's text at compile
// time) and the facts above, so an edit to any of them replayed a dependent built against the old one
// `portable` writes each deck's root as a token (compile/separate.ts `portableBy`), so the same surface has the same
// fingerprint in every clone of the repository
export function surfaceHash(surface: Program, portable: (text: string) => string = text => text): string {
  return hashText(portable(JSON.stringify(surface, withoutSpans)))
}

function withoutSpans(key: string, value: unknown): unknown {
  return key === 'span' ? undefined : typeof value === 'bigint' ? `${value}n` : value
}

// EACH DEFINITION OF A SURFACE, AS THE NAME-LEVEL CUTOFF READS IT (compile/names.tree): the names it can be reached by,
// the names it mentions, and its fingerprint. A dependent's key holds the fingerprints of the definitions it reaches by
// name, so an edit to a task it never names leaves its answer standing. A definition reached by type rather than by
// name, a mask instance, gives `*`, which every unit uses
export function nameDefs(surface: Program, portable: (text: string) => string = text => text): NameDef[] {
  return surface.map(statement => {
    const record = statement as Record<string, unknown>
    const reads = new Set<string>()

    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        reads.add(node)
      } else if (Array.isArray(node)) {
        node.forEach(walk)
      } else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key !== 'span') {
            walk(value)
          }
        }
      }
    }

    walk(record)

    return { gives: givesOf(record), reads: [...reads], print: hashText(portable(JSON.stringify(record, withoutSpans))) }
  })
}

export type NameDef = { gives: string[]; reads: string[]; print: string }

// every name a unit's own program writes: each text in its milled statements, which is more than the names it uses
// (a literal's text, a field's name) and never fewer, since a surplus name only keeps a definition in its key
export function namesUsed(program: Program): string[] {
  const used = new Set<string>(NAMES_ALWAYS_USED)

  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      used.add(node)
    } else if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key !== 'span') {
          walk(value)
        }
      }
    }
  }

  walk(program)

  return [...used]
}

function givesOf(record: Record<string, unknown>): string[] {
  const names = (list: unknown): string[] =>
    Array.isArray(list) ? list.map(one => (typeof one === 'string' ? one : String((one as { name?: unknown }).name ?? ''))) : []

  switch (record.form) {
    case 'function': {
      // a form's method is called by its method's name (`x/push`), which need not be the task's
      const method = (record.method as { name?: unknown } | undefined)?.name

      return typeof method === 'string' && method !== record.name ? [String(record.name), method] : [String(record.name)]
    }
    case 'let':
    case 'view':
    case 'bind':
      return [String(record.name)]
    case 'record-type':
      // a case is reached by its own name (`make some`, `case some`), and a form that is `like` another by every form
      // above it: a unit naming `exception` may read every exception there is (a roll, a guard's arms)
      return [
        String(record.name),
        ...names(record.variants),
        ...(Array.isArray(record.chain) ? (record.chain as string[]) : []),
        ...extendBase(record.extend),
      ]
    case 'mask':
      return [String(record.name), ...names(record.methods)]
    case 'native':
      return [String(record.alias)]
    default:
      return ['*']
  }
}

function extendBase(extend: unknown): string[] {
  const base = (extend as { base?: { kind?: string; name?: unknown } } | undefined)?.base

  return base?.kind === 'named' && typeof base.name === 'string' ? [base.name] : []
}

// the names a unit reaches without writing them: what the checker and the emitters name on a program's behalf (an
// exception's base form, a view's type, the data a `fill` makes, a pending job's handle), and `*`
export const NAMES_ALWAYS_USED = ['*', 'data', 'exception', 'view', 'type', 'text', 'maybe', 'some', 'none', 'list', 'hash', 'handle', 'spawn', 'defect', 'failure', 'data-mismatch', EXCEPTION_FORM]

// one task's share of what its unit found
function factsOf(name: string, known: StubKnown): string[] {
  const facts: [string, Set<string>][] = [
    ['clean', known.clean],
    ['state-free', known.stateFree],
    ['length-keeping', known.lengthKeeping],
    ['returns-fresh', known.returnsFresh],
    ['ends', known.ends],
    ['native', known.native],
  ]

  return facts.filter(([, set]) => set.has(name)).map(([fact]) => fact)
}

// the stub of one checked program: its public, body-less surface, in original order
export function stubProgram(program: Program, known?: StubKnown): Program {
  const out: Program = []

  for (const statement of program) {
    switch (statement.form) {
      // A PRIVATE TASK IS IN THE STUB TOO, still marked private. A dependent cannot call it, and is told so by the
      // privacy checks (check/private.ts), which need the definition to say why: without it a `find` of a private task
      // read as `unknown-name` where the whole-program build says `private-name`, and the one place that did say it
      // was the dependency's own check seeing its importer's scope, an answer that then reached every other importer.
      // A test of the same package may call one, and its module exports it
      case 'function': {
        // a one-statement body that sends a value back is what the shape readers recognize (check/facts.ts
        // `onlyStatement`). Nothing longer is carried, so an edit inside a longer body still cuts off at the stub
        const only = statement.body.length === 1 && statement.body[0]!.form === 'return' ? statement.body[0] : undefined

        out.push({
          ...statement,
          // only a task that HAD a body carries facts: a declaration with none stays a declaration, which its
          // implementation overrides (check/overload.ts `bindByImport`), and a stub with facts stands for a definition
          ...(known && statement.body.length > 0 && !statement.claim
            ? {
                stubFacts: factsOf(statement.name, known),
                stubWrites: [...(known.writes.get(statement.name) ?? [])].sort((a, b) => a - b),
                stubRaises: [...(known.raises.get(statement.name) ?? [])].sort(),
              }
            : {}),
          ...(known && only ? { stubShape: only } : {}),
          // arity-overload mangling (`name__<arity>`, code/check/overload.ts) is undone: the DEPENDENT unit runs its
          // own disambiguation over these stubs plus its calls, which re-derives the identical mangled names, so the
          // emitted imports line up with the owning unit's exports
          // A same-arity TYPED overload carries two suffixes (`sleep__1__0`, `sleep__1__1`) and a task two files define
          // is split first (`name__in<g>_<k>`), so the whole chain comes off: stripping one suffix left `sleep__1`, a
          // name nothing imports, and `sleep` was undefined in every dependent
          name: statement.name.replace(/(__in\d+_\d+)?(__\d+)*$/, ''),
          // and the name this unit's module exports it by, which a dependent naming it otherwise imports it as
          stubExport: statement.name,
          body: [],
          stub: true,
        })
        break
      }

      // type-level and declaration-level statements are the surface itself: dependents need the whole shape
      case 'record-type':
      case 'mask':
      case 'instance':
      case 'bind':
      case 'native':
        out.push(statement)
        break

      // a component's surface is its name and its props. Its body, as its own unit's checker left it, is a shape
      // nothing reads twice (a view's `call` becomes `{ form: 'call', value }`), and a dependent that walked it again
      // read a call with no callee (face's layout-slot)
      case 'view':
        out.push({ ...statement, body: [] })
        break

      // a top-level let is observable (its name and type resolve in dependents). Under the name it was WRITTEN with:
      // a constant a task elsewhere shares its name with is renamed apart in its own unit (`focus__value0`,
      // check/overload.ts `bindValuesApart`), and a dependent whose `find focus` reached it found only the task. The
      // dependent splits the two again by its own imports
      case 'let':
        out.push({ ...statement, name: statement.name.replace(/__value\d+$/, ''), stubExport: statement.name })
        break

      // proof obligations, top-level expressions, and everything else belong to the owning unit
      default:
        break
    }
  }

  return out.map(statement => written(freed(structuredClone(statement))))
}

// a form's name as its own unit's checker left it: split from another form of the name (`pair__in0_1`, check/scope.ts)
// or from a case of the name (`view__form`)
const RENAMED_FORM = /(__in\d+_\d+|__form)+$/

// EVERY FORM IN A STUB UNDER THE NAME IT WAS WRITTEN WITH, and every type that names one. A form a unit renamed apart
// (`view__form`, beside a case named `view` elsewhere) reached a dependent under that name, so the type `view` its
// route dispatcher names was undefined there (site's route test). The dependent splits the names again by its own
// imports. A form or mask keeps the name its module exports it by as `stubExport`
function written<T>(statement: T): T {
  const record = statement as Record<string, unknown>

  if ((record.form === 'record-type' || record.form === 'mask') && typeof record.name === 'string' && RENAMED_FORM.test(record.name)) {
    record.stubExport = record.name
    record.name = record.name.replace(RENAMED_FORM, '')
  }

  if (record.form === 'instance') {
    record.mask = String(record.mask).replace(RENAMED_FORM, '')
    record.target = String(record.target).replace(RENAMED_FORM, '')
  }

  if (record.form === 'record-type') {
    if (Array.isArray(record.chain)) {
      record.chain = (record.chain as string[]).map(name => name.replace(RENAMED_FORM, ''))
    }

    if (typeof record.props === 'string') {
      record.props = record.props.replace(RENAMED_FORM, '')
    }
  }

  const method = record.method as { form?: string } | undefined

  if (record.form === 'function' && typeof method?.form === 'string') {
    record.method = { ...method, form: method.form.replace(RENAMED_FORM, '') }
  }

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(walk)

      return
    }

    const each = node as Record<string, unknown>

    if (each.kind === 'named' && typeof each.name === 'string') {
      each.name = each.name.replace(RENAMED_FORM, '')
    }

    for (const [key, value] of Object.entries(each)) {
      if (key !== 'span') {
        walk(value)
      }
    }
  }

  walk(record)

  return statement
}

// An inference variable the owning unit's checker left unsolved (a bare `like list`'s element, a parameter no use
// pinned) is a number in THAT checker's table. Carried into a dependent, it is read in the dependent's own table,
// where the same number is some other variable: zone's `read-hold-many` returned `list <113>`, and 113 was bound to
// `hold` in the unit reading it, so every batch it returned was refused as a `hold` with no field `bind`. The stub
// carries it as the mill writes an element nobody named, `unknown` and free, which the dependent fills from its own
// use, as the merged build does
function freed<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') {
      return node
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        node[i] = walk(node[i])
      }

      return node
    }

    const record = node as Record<string, unknown>

    if (record.kind === 'variable' && typeof record.id === 'number' && Object.keys(record).length === 2) {
      return { kind: 'unknown', free: true }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'span') {
        record[key] = walk(record[key])
      }
    }

    return record
  }

  return walk(value) as T
}
