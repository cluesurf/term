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

  while (i < argv.length) {
    const token = argv[i]!
    const isLong = token.startsWith('--')
    const isShort = !isLong && token.startsWith('-') && token.length > 1

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
    }
  }

  // bind positionals to the command's declared takes, in order. A variadic
  // take collects all remaining positionals from its index onward.
  let posCursor = 0

  for (const take of current.takes) {
    if (take.variadic) {
      if (args[take.name] === undefined) {
        args[take.name] = positionals.slice(posCursor)
      }

      posCursor = positionals.length
      continue
    }

    const value = positionals[posCursor]

    if (value !== undefined && args[take.name] === undefined) {
      args[take.name] = value
    }

    posCursor++
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
  }
}

/** Render `--help` text for a command from its route (path, note, takes). */
export function renderHelp(route: DockRoute): string {
  const lines: string[] = []
  lines.push(
    `seed ${route.path}${route.note ? ` - ${route.note}` : ''}`,
  )

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
