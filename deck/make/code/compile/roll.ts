// The roll: everything a build knows about every deck, as data. Built from the checked program after the passes
// that know the raise sets, so every task and route carries the exceptions it can raise. `term roll` prints it,
// `term make` writes it beside the output as `host/roll.json`, and the hive wakes with it at boot.
// See note/term/hive/02-roll.md. Pure over the program.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import { showType } from '@term/make/code/compile/node'
import { raiseSets } from '@term/make/code/check/effects'
import { EXCEPTION_FORM } from '@term/make/code/check/extend'

// the seventeen the stdlib declares, so an exception's roll entry can say which one it is under
export const GENERIC_EXCEPTIONS = new Set([
  'defect',
  'omission',
  'excess',
  'shortage',
  'mismatch',
  'exclusion',
  'absence',
  'conflict',
  'refusal',
  'anonymity',
  'denial',
  'overload',
  'outage',
  'timeout',
  'overage',
  'failure',
  'bundle',
])

export type RollEntry = {
  host: string
  kind: string
  name: string
  site: string
} & Record<string, unknown>

export type Roll = {
  deck: RollEntry[]
  exception: RollEntry[]
  task: RollEntry[]
  dock: RollEntry[]
  tell: RollEntry[]
  // a kind a deck declares with `roll <name>` (07-kind.md): one entry per declaration, and the kind's own entries
  // (every top-level constant of its form) under the kind's name beside the built-in ones
  kind: RollEntry[]
  [declared: string]: RollEntry[]
}

// the deck a source file belongs to: its name (`@term/seed`) and its root directory, from the nearest `deck.tree`
export type DeckOf = (file: string) => { name: string; root: string } | undefined

export type RollOptions = {
  // absent means the deck is read off the path (`.../link/@scope/name/...`), and `@local` for the entry's own files
  deckOf?: DeckOf
  // the project root, so a `site` under it is a path relative to it
  root?: string
}

// the deck a file belongs to, from its path, when nothing better is known
export function deckFromPath(file: string): string {
  const linked = /\/link\/(@[^/]+\/[^/]+)\//.exec(file)

  return linked ? linked[1]! : '@local'
}

function literal(value: Expression | undefined): unknown {
  if (!value) {
    return undefined
  }

  switch (value.form) {
    case 'string':
    case 'integer':
    case 'float':
    case 'boolean':
      return value.value
    default:
      return undefined
  }
}

export function buildRoll(
  program: Program,
  file: string,
  origin?: WeakMap<Statement, string>,
  options?: RollOptions,
): Roll {
  const fileOf = (s: Statement): string => origin?.get(s) ?? file

  const hostOf = (s: Statement): string =>
    options?.deckOf?.(fileOf(s))?.name ?? deckFromPath(fileOf(s))

  // a site is relative to the deck that owns the file, else to the project root, else absolute
  const siteOf = (s: Statement): string => {
    let f = fileOf(s)
    const deck = options?.deckOf?.(f)

    if (deck && f.startsWith(deck.root + '/')) {
      f = f.slice(deck.root.length + 1)
    } else if (options?.root && f.startsWith(options.root + '/')) {
      f = f.slice(options.root.length + 1)
    }

    return `${f}:${s.span.start.line}:${s.span.start.column}`
  }

  const types = new Map<
    string,
    Extract<Statement, { form: 'record-type' }>
  >()
  const exceptions = new Set<string>()

  for (const s of program) {
    if (s.form === 'record-type') {
      types.set(s.name, s)

      if (s.chain?.includes(EXCEPTION_FORM)) {
        exceptions.add(s.name)
      }
    }
  }

  const sets = raiseSets(program, exceptions)

  const roll: Roll = {
    deck: [],
    exception: [],
    task: [],
    dock: [],
    tell: [],
    kind: [],
  }

  // the kinds this build declares, and every top-level constant whose value is a record of a kind's form: an entry
  // on that kind, carried into the hive at boot by reference to the constant (the value is live, not a copy)
  const kinds = new Map<string, string>()

  for (const s of program) {
    if (s.form === 'roll') {
      kinds.set(s.name, s.like)
      roll.kind.push({ host: hostOf(s), kind: 'kind', name: s.name, site: siteOf(s), like: s.like })
      roll[s.name] ??= []
    }
  }

  if (kinds.size > 0) {
    const kindOfForm = new Map([...kinds].map(([kind, form]) => [form, kind]))

    for (const s of program) {
      if (s.form !== 'let' || s.mutable) {
        continue
      }

      const formName =
        s.init.form === 'record' ? s.init.name : s.type?.kind === 'named' ? s.type.name : undefined
      const kind = formName ? kindOfForm.get(formName) : undefined

      if (kind) {
        roll[kind]!.push({ host: hostOf(s), kind, name: s.name, site: siteOf(s), like: formName, ref: s.name })
      }
    }
  }

  // decks: one entry per host seen, with how many files it contributed
  const decks = new Map<string, Set<string>>()

  for (const s of program) {
    const host = hostOf(s)
    const files = decks.get(host) ?? new Set<string>()
    files.add(fileOf(s))
    decks.set(host, files)
  }

  for (const [host, files] of [...decks].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    roll.deck.push({
      host,
      kind: 'deck',
      name: host,
      site: '',
      file: files.size,
    })
  }

  // exceptions
  for (const s of program) {
    if (s.form !== 'record-type' || !exceptions.has(s.name)) {
      continue
    }

    const chain = s.chain ?? []
    const under = [...chain]
      .reverse()
      .find(name => GENERIC_EXCEPTIONS.has(name))
    const props = s.props ? types.get(s.props) : undefined
    const link: Record<string, string> = {}

    for (const f of props?.fields ?? []) {
      link[f.name] = showType(f.type) + (f.optional ? '?' : '')
    }

    const note = s.pins?.find(p => p.name === 'note')

    roll.exception.push({
      host: hostOf(s),
      kind: 'exception',
      name: s.name,
      site: siteOf(s),
      like: under ?? chain[chain.length - 1] ?? EXCEPTION_FORM,
      chain,
      note: literal(note?.value),
      link,
    })
  }

  // tasks: every public, non-stub function, with its raise set
  const raisesOf = (name: string): string[] =>
    [...(sets.raises.get(name) ?? [])].sort()

  // one call path from a task to the site that raises an exception it can raise: the callees `via` recorded, in order,
  // ending at the direct raiser. Empty when the task raises it itself. `term roll exception --path` prints these.
  const pathOf = (name: string, exception: string): string[] => {
    const chain: string[] = []
    let at = name

    while (chain.length < 64) {
      const next = sets.via.get(at)?.get(exception)

      if (next === undefined) {
        break
      }

      chain.push(next)
      at = next
    }

    return chain
  }

  for (const s of program) {
    if (s.form !== 'function' || s.stub || s.private) {
      continue
    }

    roll.task.push({
      host: hostOf(s),
      kind: 'task',
      name: s.method ? `${s.method.form}/${s.method.name}` : s.name,
      site: siteOf(s),
      take: s.params.map(p => ({
        name: p.name,
        like: p.type ? showType(p.type) : 'unknown',
        ...(p.optional ? { need: false } : {}),
        ...(p.positional ? { slot: true } : {}),
      })),
      like: s.result ? showType(s.result) : 'unknown',
      halt: raisesOf(s.name),
      ...(raisesOf(s.name).length
        ? { path: Object.fromEntries(raisesOf(s.name).map(e => [e, pathOf(s.name, e)])) }
        : {}),
      ...(s.async ? { async: true } : {}),
    })
  }

  // docks: each route with the union of what its handlers raise
  const routeRaises = (calls: { name: string }[]): string[] => {
    const out = new Set<string>()

    for (const call of calls) {
      for (const r of raisesOf(call.name)) {
        out.add(r)
      }
    }

    return [...out].sort()
  }

  type Dock = Extract<Statement, { form: 'dock' }>

  const walkRoute = (
    s: Dock,
    route: Dock['route'],
    prefix: string,
  ): void => {
    const path = prefix
      ? `${prefix}/${route.path}`.replace(/\/+/g, '/')
      : route.path

    if (route.methods.length === 0) {
      roll.dock.push({
        host: hostOf(s),
        kind: 'dock',
        name: path,
        site: siteOf(s),
        halt: routeRaises(route.calls),
      })
    }

    for (const method of route.methods) {
      roll.dock.push({
        host: hostOf(s),
        kind: 'dock',
        name: `${method.name} ${path}`,
        site: siteOf(s),
        halt: routeRaises([...route.calls, ...method.calls]),
      })
    }

    for (const child of route.children) {
      walkRoute(s, child, path)
    }
  }

  for (const s of program) {
    if (s.form === 'dock') {
      walkRoute(s, s.route, '')
    }
  }

  // tells
  for (const s of program) {
    if (s.form !== 'tell') {
      continue
    }

    roll.tell.push({
      host: hostOf(s),
      kind: 'tell',
      name: s.name,
      site: siteOf(s),
      note: s.note,
      ...(s.hint ? { hint: s.hint } : {}),
      link: s.links,
      ...(s.alias ? { alias: s.alias } : {}),
    })
  }

  return roll
}

// merge several rolls (one per compiled entry) into one, deduplicating entries by host, kind and name
export function mergeRolls(rolls: Roll[]): Roll {
  const out: Roll = {
    deck: [],
    exception: [],
    task: [],
    dock: [],
    tell: [],
    kind: [],
  }
  const seen = new Set<string>()

  for (const roll of rolls) {
    for (const kind of Object.keys(roll)) {
      out[kind] ??= []

      for (const entry of roll[kind] ?? []) {
        const key = `${entry.host} ${entry.kind} ${entry.name}`

        if (seen.has(key)) {
          continue
        }

        seen.add(key)
        out[kind]!.push(entry)
      }
    }
  }

  for (const kind of Object.keys(out)) {
    out[kind]?.sort(
      (a, b) =>
        a.host.localeCompare(b.host) || a.name.localeCompare(b.name),
    )
  }

  return out
}

// the roll as a tree, the way `term roll` prints it
export function showRoll(
  roll: Roll,
  kind?: string,
  // `path`: under each exception, one call path per task that can raise it (`term roll exception --path`), and
  // under each task the path to each exception it raises
  options?: { path?: boolean },
): string {
  const lines: string[] = []
  const withPath = options?.path === true

  if (!kind) {
    lines.push('roll')

    for (const deck of roll.deck) {
      lines.push(`  deck ${deck.name}`)

      for (const k of ['exception', 'task', 'dock', 'tell'] as const) {
        const count = roll[k].filter(e => e.host === deck.name).length

        if (count > 0) {
          lines.push(`    ${k} ${count}`)
        }
      }
    }

    return lines.join('\n')
  }

  const entries =
    (roll as unknown as Record<string, RollEntry[]>)[kind] ?? []

  for (const entry of entries) {
    // a tell already names the full `@deck/form`
    lines.push(
      entry.name.startsWith('@')
        ? `${kind} ${entry.name}`
        : `${kind} ${entry.host}/${entry.name}`,
    )

    for (const [key, value] of Object.entries(entry)) {
      if (
        key === 'host' ||
        key === 'kind' ||
        key === 'name' ||
        value === undefined
      ) {
        continue
      }

      // a task's paths print only when asked, as `path <exception>, <task> > <callee> > <raiser>`
      if (key === 'path') {
        if (withPath && typeof value === 'object' && value !== null) {
          for (const [exception, chain] of Object.entries(value as Record<string, string[]>)) {
            lines.push(`  path ${exception}, ${[entry.name, ...chain].join(' > ')}`)
          }
        }

        continue
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            const parts = Object.entries(item as Record<string, unknown>)
              .map(([k, v]) => (k === 'name' ? String(v) : `${k} ${String(v)}`))
              .join(', ')
            lines.push(`  ${key} ${parts}`)
          } else {
            lines.push(`  ${key} ${String(item)}`)
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(
          value as Record<string, unknown>,
        )) {
          lines.push(`  ${key} ${k}, like ${String(v)}`)
        }
      } else if (typeof value === 'string' && key === 'site') {
        lines.push(`  ${key} <${value}>`)
      } else if (typeof value === 'string') {
        lines.push(`  ${key} <${value}>`)
      } else {
        lines.push(`  ${key} ${String(value)}`)
      }
    }

    // where an exception can come out: every task whose raise set holds it, with its call path to the raise site
    if (withPath && kind === 'exception') {
      for (const task of roll.task) {
        const paths = task.path as Record<string, string[]> | undefined
        const chain = paths?.[entry.name]

        if (chain !== undefined) {
          lines.push(`  path ${task.host}/${String(task.name)}${chain.length ? ` > ${chain.join(' > ')}` : ''}`)
        }
      }
    }

    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
