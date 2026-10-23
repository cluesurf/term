// The CLI dispatcher for the `hook` command DSL. The mill lowers a top-level `hook` command tree to `dock` route
// statements (path = command name, takes = args/flags, calls[0] = the bound implementation task, children =
// subcommands). This walks that route tree against a real argv: it descends matching subcommands, parses the
// remaining `--flag value` / `--flag=value` / boolean flags and positionals, binds positionals to the command's
// SLOTS in order, and returns the bound task plus the collected arguments. A thin runtime layer then calls the task's
// handler. Pure and browser-safe (no process / yargs); the entry point feeds it `process.argv`.
//
// A CONSOLE IS ONE PROGRAM HOOK (decision term/003 part 3): `hook term` holds every command as a nested hook, and its
// takes are the global options. A hook's takes reach every hook nested in it: an ancestor's flag is accepted anywhere
// on the line after the command, and its value is the console's (`globals`), never a task's argument. A file of
// several top-level hooks, or of one hook with no commands under it, is read as before: its top-level hooks are the
// commands and there are no globals (`programOf`).

import type {
  Program,
  Statement,
} from '@term/make/code/compile/node'
import type { DockRoute, DockTake } from '@term/make/code/compile/node'

// the emitted-identifier mapping, re-exported so the generated CLI entry
// resolves task names exactly as the emitter wrote them
export { toCamel } from '@term/make/code/compile/typescript'

// the CLI command routes of a program: every top-level `hook` (lowered to a dock statement). Each bound call carries
// its task's parameter names, so a command hands each take to the parameter of the same name: they went in take
// order, so a hook that listed `second` before `first` gave `first` the second value, and `pair --first a --second b`
// printed `first=b second=a` (guides: applications/command-line, 2026-10-03)
export function commandRoutes(program: Program): DockRoute[] {
  const params = new Map<string, string[]>()

  for (const s of program) {
    if (s.form === 'function') {
      params.set(s.name, s.params.map(p => p.name))
    }
  }

  const named = (route: DockRoute): DockRoute => ({
    ...route,
    calls: route.calls.map(call => (params.has(call.name) ? { ...call, params: params.get(call.name) } : call)),
    children: route.children.map(named),
  })

  return program
    .filter(
      (s): s is Extract<Statement, { form: 'dock' }> =>
        s.form === 'dock',
    )
    .map(s => named(s.route))
}

// THE PROGRAM a console's routes are. A console file has one top-level hook, the program, whose nested hooks are the
// commands and whose takes are the global options. Anything else (a test's several top-level commands, an app of
// one command with nothing nested) has no program: its top-level hooks are the commands
export function programOf(routes: DockRoute[]): {
  program?: DockRoute
  commands: DockRoute[]
} {
  const only = routes.length === 1 ? routes[0] : undefined

  return only && only.children.length > 0
    ? { program: only, commands: only.children }
    : { commands: routes }
}

export type ArgValue = string | boolean | number | string[]

export type Dispatch =
  | {
      ok: true
      command: string[] // the resolved command path, e.g. ['make', 'face']
      task?: string // the bound implementation task name (calls[0])
      args: Record<string, ArgValue>
      // the values of the takes of the hooks ABOVE the command (the program's global options), which the console
      // reads itself and never hands to the task
      globals: Record<string, ArgValue>
      route: DockRoute // the matched command, for arg order + help
    }
  | { ok: false; error: string; command: string[] }

// the take a flag word names among these takes: by its name, any of its long aliases, or its short letter. The
// first match wins, so a command's own take shadows an ancestor's of the same name
function takeNamed(takes: DockTake[], word: string, short: boolean): DockTake | undefined {
  return short
    ? takes.find(take => take.short === word)
    : takes.find(take => take.name === word || (take.aliases ?? []).includes(word))
}

// A MAYBE TAKE (`like maybe, like number`, decision cli-in-term/008 part 1) can be absent: its route's type is the
// named `maybe` with its item as the one argument. A given word is read by the ITEM's kind, so `--runs 0` is the
// number 0, never the text
function maybeItem(take: DockTake): DockTake['type'] | undefined {
  const type = take.type

  return type?.kind === 'named' && type.name === 'maybe' ? type.args?.[0] : undefined
}

// the kind a take's word is read as: a maybe take's item's, else its own type's
function kindOf(take: DockTake | undefined): string | undefined {
  return take ? (maybeItem(take) ?? take.type)?.kind : undefined
}

// resolve an argv (without the node + script prefix) against the command routes
export function dispatch(
  routes: DockRoute[],
  argv: string[],
): Dispatch {
  const { program, commands } = programOf(routes)
  let level = commands
  let current: DockRoute | undefined

  const command: string[] = []
  // the takes of every hook above the command, the nearest first: the program's, then each group's on the way down
  let above: DockTake[] = program ? [...program.takes] : []

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

    if (current) {
      above = [...current.takes, ...above]
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

  // A PASSING COMMAND (`mark pass`, decision cli-in-term/008 part 2) hands every word after its path to another
  // console untouched: its one list slot takes them verbatim, `--help`, `--` and unknown flags included, and nothing
  // is parsed here
  if (current.passes) {
    const slot = current.takes[0]

    return {
      ok: true,
      command,
      task: current.calls[0]?.name,
      args: slot ? { [slot.name]: argv.slice(i) } : {},
      globals: {},
      route: current,
    }
  }

  // every take a flag may name here: the command's own first, so one shadows an ancestor's of the same name
  const own = current.takes
  const reachable = [...own, ...above]
  // a flag word to the take it names, by name, long alias or short letter. A word no take names is kept as written,
  // and refused below
  const keyOf = (word: string, short: boolean): string => takeNamed(reachable, word, short)?.name ?? word
  // A LIST TAKE IS A REPEATABLE OPTION (decision cli-in-term/010): `--law a --law b` collects `[a, b]` in line order. A
  // list slot is the rest of the words instead, and is never named by a flag here
  const repeats = (key: string): boolean => {
    const take = reachable.find(one => one.name === key)

    return take !== undefined && !take.positional && take.type?.kind === 'array'
  }
  const setArg = (key: string, value: string | boolean): void => {
    if (repeats(key) && typeof value === 'string') {
      const held = args[key]
      args[key] = [...(Array.isArray(held) ? held : []), value]
    } else {
      args[key] = value
    }
  }

  // parse the rest: --flag / -f value, --flag=value, --no-flag, boolean flags, positionals
  const args: Record<string, ArgValue> = {}
  const positionals: string[] = []

  // a variadic command (`view call npm run dev`) carries a child command
  // line in its trailing take. Once the child's argv begins, its own
  // flags (`node -e`, `npm --version`) must NOT be read as this
  // command's flags. So for a variadic route, flag parsing stops at the
  // first bare token (or a literal `--`), and everything after is raw
  // positional. A non-variadic command keeps interspersed flags.
  const variadic = current.takes.some(take => take.variadic)
  let raw = false
  // how many positionals came before a literal `--`: a word after it that no slot holds is the task's to read from the
  // process (`term boot x.tree -- list` hands `list` to the booted program, work/inspect-verbs.tree words-after-dashes),
  // never refused, as yargs left it
  let dashedAt = Infinity

  while (i < argv.length) {
    const token = argv[i]!

    // a literal `--` ends option parsing: the remainder is verbatim
    if (token === '--') {
      if (!raw) {
        dashedAt = positionals.length
      }

      raw = true
      i++
      continue
    }

    const isLong = !raw && token.startsWith('--')
    const isShort =
      !raw && !isLong && token.startsWith('-') && token.length > 1

    if (isLong || isShort) {
      const body = token.slice(isLong ? 2 : 1)

      // boolean negation: `--no-cache` sets cache=false, through an alias too
      if (isLong && body.startsWith('no-')) {
        args[keyOf(body.slice(3), false)] = false
        i++
        continue
      }

      const eq = body.indexOf('=')

      if (eq >= 0) {
        const raw = body.slice(0, eq)
        const key = keyOf(raw, isShort)
        setArg(key, body.slice(eq + 1))
        i++
      } else {
        const key = keyOf(body, isShort)
        const value = argv[i + 1]
        // a boolean flag stands alone, and takes the next word only when it is `true` or `false`: `-l ada` is the
        // flag and then the positional `ada`
        const flag = kindOf(reachable.find(take => take.name === key)) === 'boolean'

        if (value !== undefined && !value.startsWith('-') && (!flag || value === 'true' || value === 'false')) {
          setArg(key, value)
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

  // A FLAG NO TAKE NAMES IS AN ERROR. `greet ada --typo` printed `hello, ada` and exited 0, so a misspelled option was
  // the option left out, in silence (guides: applications/command-line, 2026-10-03). An ancestor's take is known here
  // too: the program's options are accepted on every command
  const known = new Set(reachable.map(take => take.name))

  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      const listed = own.map(take => take.name)

      return {
        ok: false,
        command,
        error: `unknown flag "${key.length === 1 ? `-${key}` : `--${key}`}"${
          listed.length > 0 ? `. The flags are ${listed.map(name => `--${name}`).join(', ')}` : ''
        }`,
      }
    }
  }

  // POSITIONALS BIND TO SLOTS ONLY, in order (decision term/003 part 1): a `take` is only ever a flag, so `term make
  // foo.tree` cannot set the first flag. A slot already filled by its flag (`--file x`, as yargs allows) does NOT
  // consume a positional, and the cursor only advances when a positional is actually taken. A list slot takes every
  // word left
  let posCursor = 0

  for (const take of own) {
    if (!take.positional) {
      continue
    }

    if (take.variadic) {
      if (args[take.name] === undefined) {
        args[take.name] = positionals.slice(posCursor)
      }

      posCursor = positionals.length
      continue
    }

    if (args[take.name] !== undefined) {
      continue
    }

    const value = positionals[posCursor]

    if (value !== undefined) {
      args[take.name] = value
      posCursor++
    }
  }

  // a positional no slot was left to hold is an error too, rather than a word dropped
  if (posCursor < positionals.length && posCursor < dashedAt) {
    return {
      ok: false,
      command,
      error: `unexpected argument "${positionals[posCursor]}"`,
    }
  }

  // coerce by declared type, validate choices, then apply defaults, for the command's takes and every ancestor's
  for (const take of reachable) {
    const value = args[take.name]

    if (value !== undefined && typeof value === 'string') {
      // choices / enum validation
      if (take.choices && !take.choices.includes(value)) {
        return {
          ok: false,
          command,
          error: `--${take.name} must be one of: ${take.choices.join(', ')} (got "${value}")`,
        }
      }

      // type coercion, which refuses a value that is not the type. `--times x` for a `like number` take reached the
      // task as the text `x`, and `--loud yes` as false (guides: applications/command-line, 2026-10-03)
      const kind = kindOf(take)

      if (kind === 'number' || kind === 'float') {
        const n = Number(value)
        const whole = kind === 'number'

        if (value.trim() === '' || Number.isNaN(n) || (whole && !Number.isInteger(n))) {
          return {
            ok: false,
            command,
            error: `--${take.name} takes ${whole ? 'a whole number' : 'a number'}, not "${value}"`,
          }
        }

        args[take.name] = n
      } else if (kind === 'boolean') {
        if (value !== 'true' && value !== 'false') {
          return {
            ok: false,
            command,
            error: `--${take.name} is true or false, not "${value}"`,
          }
        }

        args[take.name] = value === 'true'
      }
    }

    // default value when nothing was provided
    if (args[take.name] === undefined && take.fallback !== undefined) {
      args[take.name] = take.fallback.value
    }
  }

  // an ancestor's value is the console's, never the task's: a name the command declares itself stays the command's
  // (and the console reads it too, as yargs gave a global option to both)
  const globals: Record<string, ArgValue> = {}
  const mine = new Set(own.map(take => take.name))

  for (const take of above) {
    const value = args[take.name]

    if (value !== undefined) {
      globals[take.name] = value

      if (!mine.has(take.name)) {
        delete args[take.name]
      }
    }
  }

  return {
    ok: true,
    command,
    task: current.calls[0]?.name,
    args,
    globals,
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

      // a maybe take by its item (decision cli-in-term/008: `--runs` is a number)
      const kind = kindOf(take)

      if (kind) {
        meta.push(kind)
      }

      if (take.required) {
        meta.push('required')
      }

      if (take.fallback !== undefined) {
        meta.push(`default ${JSON.stringify(take.fallback.value)}`)
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
 * (so `view call npm test` fails a build exactly as `npm test` would),
 * a non-number result is 0, and a usage error is 2 without ever
 * reaching the task.
 */
/**
 * What to call this program in its own usage and help.
 *
 * A console compiled from `deck.tree` knows its package name, which is right
 * when it is run directly and wrong when it is run as a subcommand of
 * something else. `term zone` sets this so the help says `term zone read`
 * rather than `view read`, and a person can paste what they are shown.
 */
function shownName(name: string): string {
  return process.env.TERM_LINE_NAME || name
}

// Where the console's own words end: just past the path of a passing command (`mark pass`), or the whole line when
// the bare words reach none. The descent skips flag words, as the help walk does, so `--help zone` still names zone
function passingCut(commands: DockRoute[], argv: string[]): number {
  let level = commands

  for (let at = 0; at < argv.length; at++) {
    const token = argv[at]!

    if (token.startsWith('-')) {
      continue
    }

    const next = level.find(r => r.path === token)

    if (!next) {
      break
    }

    if (next.passes) {
      return at + 1
    }

    level = next.children
  }

  return argv.length
}

export async function runCommandLine(input: RunInput): Promise<number> {
  const { name: given, routes, argv, resolve } = input
  const name = shownName(given)
  const out = input.out ?? ((line: string) => console.log(line))
  const err = input.err ?? ((line: string) => console.error(line))

  // the commands are the program's nested hooks, when the console is one program hook
  const { commands } = programOf(routes)
  // strip help flags anywhere in the line, remembering that help was
  // asked for. `view code save --help` renders the save command's help.
  // Only BEFORE a passing command's path: every word after it is another
  // console's (`term zone --help` is zone's help, decision cli-in-term/008)
  // A literal `--` ends the console's words the same way, as it ends option parsing (`term boot x.tree -- --help`
  // hands `--help` to the booted program, as yargs did)
  const dashes = argv.indexOf('--')
  const cut = Math.min(passingCut(commands, argv), dashes === -1 ? argv.length : dashes)
  const head = argv.slice(0, cut)
  const wantHelp = head.some(a => a === '--help' || a === '-h')
  const bare = [...head.filter(a => a !== '--help' && a !== '-h'), ...argv.slice(cut)]

  if (bare.length === 0) {
    out(renderUsage(name, commands))

    return wantHelp ? 0 : 2
  }

  if (wantHelp) {
    // walk the bare tokens to the deepest matching command
    let level = commands
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
      out(renderUsage(name, commands))

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

  // a group command with no bound task (like `view code`) lists its
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

  // arguments go to the task BY NAME: each parameter takes the take of its own name, and one no take names takes the
  // take at its position. A route compiled before the names were recorded falls back to take order. A maybe take is
  // the program's own maybe value, `none` when absent and `some` of the value when given (the shape `__termMaybe`
  // builds, compile/ts-preludes.tree; decision cli-in-term/008 part 1). Absent plain optionals become their natural
  // zero: false for a boolean, [] for a variadic, "" for everything else.
  const params = hit.route.calls[0]?.params
  const takes = params
    ? params.map((param, index) => hit.route.takes.find(take => take.name === param) ?? hit.route.takes[index])
    : hit.route.takes
  const ordered = takes.filter((take): take is NonNullable<typeof take> => take !== undefined).map(take => {
    const value = hit.args[take.name]

    if (maybeItem(take) !== undefined) {
      return value === undefined ? { form: 'none' } : { form: 'some', value }
    }

    if (value !== undefined) {
      return value
    }

    // a list slot (the rest of the words) and a list option (decision cli-in-term/010) left out are the empty list
    if (take.variadic || take.type?.kind === 'array') {
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
