// The roll: everything a build knows about every deck, as data. Built from the checked program after the passes
// that know the raise sets, so every task and route carries the exceptions it can raise. `term roll` prints it,
// `term make` writes it beside the output as `host/roll.json`, and the hive wakes with it at boot.
// See note/term/hive/02-roll.md. Pure over the program.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import { raiseSets } from '@term/make/code/check/effects'
import { EXCEPTION_FORM, GENERIC_EXCEPTIONS } from '@term/make/code/check/extend'
import { showType } from '@term/make/code/compile/type-text'

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

// the deck a source file belongs to: its name (`@term/base`) and its root directory, from the nearest `deck.tree`
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
  options?: RollOptions,
): Roll {
  const fileOf = (s: Statement): string => s.span.file ?? file

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

    // counted from one, as every error frame counts (parser/diagnostic.ts). It printed the span's own zero-based
    // numbers until 2026-10-04, so `store.tree:17:0` was line 18 (guides: commands/roll)
    return `${f}:${s.span.start.line + 1}:${s.span.start.column + 1}`
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

  // `failure` always: a native shim raises it by construction, and the program holds its form only when the closure
  // kept it, so without it one task's raises changed with whichever entry built the roll (task/term/roll-cover.ts
  // found `float-floor` raising in some entries' rolls and not in others, 2026-10-05)
  const sets = raiseSets(program, new Set([...exceptions, 'failure']))

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
      // an optional field as the source writes it, `need false`, not TypeScript's `?`
      link[f.name] = showType(f.type) + (f.optional ? ', need false' : '')
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

  roll.supervision = supervisionEntries(program, s => ({ host: hostOf(s), site: siteOf(s) }))

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
// THE SUPERVISION TREES (deck/base/code/supervisor.tree): every `make-supervisor` written with literal limits, its
// strategy, its limits, its children, and its WORST CASE. A nested supervisor that exhausts its own `intensity` stops and
// counts as one failure of its parent, which restarts it up to the parent's `intensity` times, so the workers under a
// supervisor can restart `intensity × Π (ancestor intensity + 1)` times before the root itself stops. OTP computes this
// nowhere, and a restart storm through a tree each of whose levels looked safe is how it bites
// (note/term/research/beam-otp-lessons.md, design 4). A tree whose limits are not written as literals is listed with
// what is known and no worst case.
function supervisionEntries(
  program: Program,
  where: (s: Statement) => { host: string; site: string },
): RollEntry[] {
  type Call = Extract<Expression, { form: 'call' }>
  type Node = {
    call: Call
    owner: Statement
    name: string
    strategy?: string
    intensity?: number
    period?: number
    workers: number
    nested: Call[]
    parent?: Node
  }
  const nodes = new Map<Call, Node>()

  const visit = (value: unknown, owner: Statement, found: Call[], pushed: Map<string, Expression[]>): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => visit(v, owner, found, pushed))

      return
    }

    const record = value as Record<string, unknown>

    if (record.form === 'call') {
      const call = record as unknown as Call

      if (call.callee.form === 'variable' && call.callee.name === 'make-supervisor') {
        found.push(call)
      }

      // `call children/push / <child>`: what a children list receives, by the list's name
      if (call.callee.form === 'member' && call.callee.name === 'push' && call.callee.target.form === 'variable') {
        const list = pushed.get(call.callee.target.name) ?? []

        list.push(...call.args)
        pushed.set(call.callee.target.name, list)
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'type' && key !== 'span') {
        visit(child, owner, found, pushed)
      }
    }
  }

  for (const s of program) {
    if (s.form !== 'function') {
      continue
    }

    const found: Call[] = []
    const pushed = new Map<string, Expression[]>()

    visit(s.body, s, found, pushed)

    for (const call of found) {
      const [name, strategy, intensity, period, children] = call.args
      const items =
        children?.form === 'variable'
          ? (pushed.get(children.name) ?? [])
          : children?.form === 'array'
            ? children.items
            : []
      const kids = items.filter((i): i is Extract<Expression, { form: 'record' }> => i.form === 'record')

      nodes.set(call, {
        call,
        owner: s,
        name: typeof literal(name) === 'string' ? (literal(name) as string) : '(computed)',
        strategy: strategy?.form === 'record' ? strategy.name : undefined,
        intensity: typeof literal(intensity) === 'number' ? (literal(intensity) as number) : undefined,
        period: typeof literal(period) === 'number' ? (literal(period) as number) : undefined,
        workers: kids.filter(k => k.name === 'worker').length,
        nested: kids
          .filter(k => k.name === 'nested')
          .map(k => k.fields.find(f => f.name === 'tree')?.value)
          .filter((t): t is Call => t?.form === 'call'),
      })
    }
  }

  for (const node of nodes.values()) {
    for (const inner of node.nested) {
      const child = nodes.get(inner)

      if (child) {
        child.parent = node
      }
    }
  }

  const worst = (node: Node): number | undefined => {
    if (node.intensity === undefined) {
      return undefined
    }

    let total = node.intensity

    for (let up = node.parent; up; up = up.parent) {
      if (up.intensity === undefined) {
        return undefined
      }

      total *= up.intensity + 1
    }

    return total
  }

  return [...nodes.values()].map(node => {
    const { host, site } = where(node.owner)
    const most = worst(node)

    return {
      host,
      kind: 'supervision',
      name: node.name,
      site,
      ...(node.strategy ? { strategy: node.strategy } : {}),
      ...(node.intensity !== undefined ? { intensity: node.intensity } : {}),
      ...(node.period !== undefined ? { period: node.period } : {}),
      worker: node.workers,
      nested: node.nested.map(n => nodes.get(n)?.name ?? '(computed)'),
      ...(node.parent ? { under: node.parent.name } : {}),
      ...(most !== undefined ? { worst: most } : {}),
    }
  })
}

export function mergeRolls(rolls: Roll[]): Roll {
  const merger = makeRollMerger()

  for (const roll of rolls) {
    merger.add(roll)
  }

  return merger.done()
}

// the merge one roll at a time, the first entry of each name kept, so a caller holds the merged roll and never every
// roll at once. Every entry's roll covers its whole closure, and @term/bind's 3,091 of them held together ran the
// main thread out of its 4 GB heap after a cold build (2026-10-05)
export function makeRollMerger(): { add: (roll: Roll) => void; done: () => Roll } {
  const out: Roll = {
    deck: [],
    exception: [],
    task: [],
    dock: [],
    tell: [],
    kind: [],
  }
  const seen = new Set<string>()

  const add = (roll: Roll): void => {
    for (const kind of Object.keys(roll)) {
      out[kind] ??= []

      for (const entry of roll[kind] ?? []) {
        // the site too: a name is scoped to its module, so two files' `task true-reads-and-writes-back` are two tasks,
        // and keyed by name alone the second was dropped from the merged roll (task/term/roll-cover.ts, 2026-10-05)
        const key = `${entry.host} ${entry.kind} ${entry.name} ${entry.site}`

        if (seen.has(key)) {
          continue
        }

        seen.add(key)
        out[kind]!.push(entry)
      }
    }
  }

  const done = (): Roll => {
    for (const kind of Object.keys(out)) {
      out[kind]?.sort(
        (a, b) =>
          a.host.localeCompare(b.host) || a.name.localeCompare(b.name),
      )
    }

    return out
  }

  return { add, done }
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
