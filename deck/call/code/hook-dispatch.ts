// The CLI dispatcher for the `hook` command DSL. The mill lowers a top-level `hook` command tree to `dock` route
// statements (path = command name, takes = args/flags, calls[0] = the bound implementation task, children =
// subcommands). This walks that route tree against a real argv: it descends matching subcommands, parses the
// remaining `--flag value` / `--flag=value` / boolean flags and positionals, maps positionals to the command's takes
// in order, and returns the bound task plus the collected arguments. A thin runtime layer then calls the task's
// handler. Pure and browser-safe (no process / yargs); the entry point feeds it `process.argv`.

import type {
  Program,
  Statement,
} from '@term/make/code/compile/node'
import type { DockRoute } from '@term/make/code/compile/node'

// the emitted-identifier mapping, re-exported so the generated CLI entry
// resolves task names exactly as the emitter wrote them
export { toCamel } from '@term/make/code/compile/typescript'

// the CLI command routes of a program: every top-level `hook` (lowered to a dock statement)
export function commandRoutes(program: Program): DockRoute[] {
  return program
    .filter(
      (s): s is Extract<Statement, { form: 'dock' }> =>
        s.form === 'dock',
    )
    .map(s => s.route)
}

export type ArgValue = string | boolean | number | string[]

export type Dispatch =
  | {
      ok: true
      command: string[] // the resolved command path, e.g. ['make', 'face']
      task?: string // the bound implementation task name (calls[0])
      args: Record<string, ArgValue>
      route: DockRoute // the matched command, for arg order + help
    }
  | { ok: false; error: string; command: string[] }

// resolve an argv (without the node + script prefix) against the command routes
export function dispatch(
  routes: DockRoute[],
  argv: string[],
): Dispatch {
  let level = routes
  let current: DockRoute | undefined

  const command: string[] = []

  let i = 0

  // descend subcommands while the next bare token names one
  while (i < argv.length) {
    const token = argv[i]!

    if (token.startsWith('-')) {
      break
    }

    const next = level.find(r => r.path === token)

    if (!next) {
      break
    }

    current = next
    command.push(next.path)
    level = next.children
    i++
  }

  if (!current) {
    return {
      ok: false,
      error:
        argv.length === 0
          ? 'no command given'
          : `unknown command "${argv[0]}"`,
      command,
    }
  }

  // short-flag letter -> the take's full name, so `-t` resolves to `--title`
  const shortToName = new Map<string, string>()

  for (const take of current.takes) {
    if (take.short) {
      shortToName.set(take.short, take.name)
    }
  }

  // parse the rest: --flag / -f value, --flag=value, --no-flag, boolean flags, positionals
  const args: Record<string, ArgValue> = {}
  const positionals: string[] = []

  // a variadic command (`zone call npm run dev`) carries a child command
  // line in its trailing take. Once the child's argv begins, its own
  // flags (`node -e`, `npm --version`) must NOT be read as this
  // command's flags. So for a variadic route, flag parsing stops at the
  // first bare token (or a literal `--`), and everything after is raw
  // positional. A non-variadic command keeps interspersed flags.
  const variadic = current.takes.some(take => take.variadic)
  let raw = false

  while (i < argv.length) {
    const token = argv[i]!

    // a literal `--` ends option parsing: the remainder is verbatim
    if (token === '--') {
      raw = true
      i++
      continue
    }

    const isLong = !raw && token.startsWith('--')
    const isShort =
      !raw && !isLong && token.startsWith('-') && token.length > 1

    if (isLong || isShort) {
      const body = token.slice(isLong ? 2 : 1)

      // boolean negation: `--no-cache` sets cache=false
      if (isLong && body.startsWith('no-')) {
        args[body.slice(3)] = false
        i++
        continue
      }

      const eq = body.indexOf('=')

      if (eq >= 0) {
        const raw = body.slice(0, eq)
        const key = isShort ? (shortToName.get(raw) ?? raw) : raw
        args[key] = body.slice(eq + 1)
        i++
      } else {
        const key = isShort ? (shortToName.get(body) ?? body) : body
        const value = argv[i + 1]

        if (value !== undefined && !value.startsWith('-')) {
          args[key] = value
          i += 2
        } else {
          args[key] = true
          i++
        }
      }
    } else {
      positionals.push(token)
      i++

      // first bare token of a variadic command: the child's argv starts
      // here, so stop reading its flags as ours
      if (variadic && !raw) {
        raw = true
      }
    }
  }

  // bind positionals to the command's declared takes, in order. A take
  // already filled by a flag does NOT consume a positional: otherwise
  // `zone call --tier dev node script.js` would spend `node` on the
  // (already-set) tier slot and mis-bind the command name. The cursor
  // only advances when a positional is actually taken.
  let posCursor = 0

  for (const take of current.takes) {
    if (take.variadic) {
      if (args[take.name] === undefined) {
        args[take.name] = positionals.slice(posCursor)
      }

      posCursor = positionals.length
      continue
    }

    // a flag already supplied this value: leave the positionals for the
    // remaining takes
    if (args[take.name] !== undefined) {
      continue
    }

    const value = positionals[posCursor]

    if (value !== undefined) {
      args[take.name] = value
      posCursor++
    }
  }

  // coerce by declared type, validate choices, then apply defaults
  for (const take of current.takes) {
    let value = args[take.name]

    if (value !== undefined && typeof value === 'string') {
      // choices / enum validation
      if (take.choices && !take.choices.includes(value)) {
        return {
          ok: false,
          command,
          error: `--${take.name} must be one of: ${take.choices.join(', ')} (got "${value}")`,
        }
      }

      // type coercion
      if (take.type?.kind === 'number' || take.type?.kind === 'float') {
        const n = Number(value)

        if (!Number.isNaN(n)) {
          args[take.name] = n
        }
      } else if (take.type?.kind === 'boolean') {
        args[take.name] = value === 'true'
      }

      value = args[take.name]
    }

    // default value when nothing was provided
    if (args[take.name] === undefined && take.fallback !== undefined) {
      args[take.name] = take.fallback
    }
  }

  return {
    ok: true,
    command,
    task: current.calls[0]?.name,
    args,
    route: current,
  }
}

/** Render `--help` text for a command from its route (path, note, takes). */
export function renderHelp(
  route: DockRoute,
  name = 'term',
  parents: string[] = [],
): string {
  const full = [name, ...parents, route.path].join(' ')
  const lines: string[] = []
  lines.push(`${full}${route.note ? ` - ${route.note}` : ''}`)

  if (route.takes.length > 0) {
    lines.push('')
    lines.push('options:')

    for (const take of route.takes) {
      const flag = `--${take.name}${take.short ? `, -${take.short}` : ''}`
      const meta: string[] = []

      if (take.type) {
        meta.push(take.type.kind)
      }

      if (take.required) {
        meta.push('required')
      }

      if (take.fallback !== undefined) {
        meta.push(`default ${JSON.stringify(take.fallback)}`)
      }

      if (take.choices) {
        meta.push(`one of ${take.choices.join('|')}`)
      }

      if (take.variadic) {
        meta.push('variadic')
      }

      const suffix = meta.length ? `  (${meta.join(', ')})` : ''
      lines.push(`  ${flag.padEnd(22)} ${take.note ?? ''}${suffix}`)
    }
  }

  if (route.children.length > 0) {
    lines.push('')
    lines.push('subcommands:')

    for (const child of route.children) {
      lines.push(`  ${child.path.padEnd(22)} ${child.note ?? ''}`)
    }
  }

  return lines.join('\n')
}

/** Render the program-level usage: one line per top-level command. */
export function renderUsage(name: string, routes: DockRoute[]): string {
  const lines = [`usage: ${name} <command> [options]`, '', 'commands:']

  for (const route of routes) {
    lines.push(`  ${route.path.padEnd(22)} ${route.note ?? ''}`)
  }

  lines.push('')
  lines.push(`run \`${name} <command> --help\` for a command's options`)

  return lines.join('\n')
}

export type RunInput = {
  /** the program name shown in usage and help lines */
  name: string
  /** the command routes (every top-level hook) */
  routes: DockRoute[]
  /** argv without the node + script prefix */
  argv: string[]
  /** resolve a bound task name to the compiled function */
  resolve: (
    task: string,
  ) => ((...args: unknown[]) => unknown) | undefined
  /** write a line to stdout / stderr (injectable for tests) */
  out?: (line: string) => void
  err?: (line: string) => void
}

/**
 * The whole command-line lifecycle over a route tree: help, dispatch,
 * required-argument enforcement, argument ordering, execution, exit
 * code. `term boot` generates a run entry that feeds this
 * `process.argv`; tests feed it a fake argv and a fake resolver.
 *
 * Exit codes: the task's own number result passes through unchanged
 * (so `zone call npm test` fails a build exactly as `npm test` would),
 * a non-number result is 0, and a usage error is 2 without ever
 * reaching the task.
 */
/**
 * What to call this program in its own usage and help.
 *
 * A console compiled from `deck.tree` knows its package name, which is right
 * when it is run directly and wrong when it is run as a subcommand of
 * something else. `term zone` sets this so the help says `term zone read`
 * rather than `zone read`, and a person can paste what they are shown.
 */
function shownName(name: string): string {
  return process.env.TERM_LINE_NAME || name
}

export async function runCommandLine(input: RunInput): Promise<number> {
  const { name: given, routes, argv, resolve } = input
  const name = shownName(given)
  const out = input.out ?? ((line: string) => console.log(line))
  const err = input.err ?? ((line: string) => console.error(line))

  // strip help flags anywhere in the line, remembering that help was
  // asked for. `zone code save --help` renders the save command's help.
  const wantHelp = argv.some(a => a === '--help' || a === '-h')
  const bare = argv.filter(a => a !== '--help' && a !== '-h')

  if (bare.length === 0) {
    out(renderUsage(name, routes))

    return wantHelp ? 0 : 2
  }

  if (wantHelp) {
    // walk the bare tokens to the deepest matching command
    let level = routes
    let current: DockRoute | undefined

    const parents: string[] = []

    for (const token of bare) {
      const next = level.find(r => r.path === token)

      if (!next) {
        break
      }

      if (current) {
        parents.push(current.path)
      }

      current = next
      level = next.children
    }

    if (!current) {
      out(renderUsage(name, routes))

      return 0
    }

    out(renderHelp(current, name, parents))

    return 0
  }

  const hit = dispatch(routes, argv)

  if (!hit.ok) {
    err(`${name}: ${hit.error}`)
    err(`run \`${name} --help\` to see the commands`)

    return 2
  }

  // a group command with no bound task (like `zone code`) lists its
  // subcommands instead of failing opaquely
  if (!hit.task) {
    if (hit.route.children.length > 0) {
      out(renderHelp(hit.route, name, hit.command.slice(0, -1)))

      return 2
    }

    err(`${name}: ${hit.command.join(' ')} has no implementation bound`)

    return 2
  }

  // enforce declared requirements before the task runs, so the failure
  // names the argument rather than surfacing as a type error inside
  const missing = hit.route.takes.filter(
    take => take.required && hit.args[take.name] === undefined,
  )

  if (missing.length > 0) {
    for (const take of missing) {
      err(
        `${name} ${hit.command.join(' ')}: missing required <${take.name}>${
          take.note ? ` - ${take.note}` : ''
        }`,
      )
    }

    return 2
  }

  const fn = resolve(hit.task)

  if (!fn) {
    err(`${name}: task "${hit.task}" is not exported by the program`)

    return 2
  }

  // arguments go to the task in take order, the contract the route
  // declares. Absent optionals become their natural zero: false for a
  // boolean, [] for a variadic, "" for everything else.
  const ordered = hit.route.takes.map(take => {
    const value = hit.args[take.name]

    if (value !== undefined) {
      return value
    }

    if (take.variadic) {
      return []
    }

    if (take.type?.kind === 'boolean') {
      return false
    }

    if (
      take.type?.kind === 'number' ||
      take.type?.kind === 'float'
    ) {
      return 0
    }

    return ''
  })

  const result = await fn(...ordered)

  return typeof result === 'number' && Number.isInteger(result)
    ? result
    : 0
}
