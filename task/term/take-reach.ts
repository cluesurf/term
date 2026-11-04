// take-reach: does every take of every command reach code that reads it? (decision cli-in-term/013 part 2)
//
// A wrapper task a hook binds (line/base.tree make-project) took 23 takes and called its verb with 5, so
// `term make --env cobol` built the project and exited 0. It compiled clean, cli-drift read 0 (the route had every
// take) and verb-pair passed (no row passed --env). This is the static check for that class: a take is DROPPED when
//
//   - the route's task has no parameter it reaches (by name, or by position as the dispatcher fills it,
//     deck/call/code/work/hook/running.tree run-command-line), or
//   - the task never reads the parameter in its body, or
//   - the task reads it only to hand it to another task of the program that never reads it, followed down every call
//     (a wrapper to the verb it calls, the verb to its helpers).
//
// READ THROUGH THE COMPILER, never a text reader: the console is compiled as `term make` reads it (role and lean), the
// routes come from `commandRoutes`, and the read sites from compile/node-reach.tree's `reach-statements`, the
// compiler's own walk over every field of every node. A variable read whose binding is a parameter is a read of it;
// a call whose callee binds a function of the program is followed into that function.
//
// Used by task/term/cli-drift.ts (the drops), and as a command:
//
//   tsx <term>/task/term/take-reach.ts                 (from the Term root) the console's drops, exit 1 on any
//   tsx <term>/task/term/take-reach.ts --file <tree>   the drops of another console file (a fixture)
//   tsx <term>/task/term/take-reach.ts --routes        every command and its takes as JSON, for verb-pair and
//                                                      cli-coverage (task/term/verb-pair.ts, task/term/cli-coverage.ts)

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { reachStatements } from '@term/make/code/compile/node-reach'
import { commandRoutes, programOf } from '@term/call/code/work/hook/parsing'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import type { DockRoute, DockTake, Expression, Program, Statement } from '@term/make/code/compile/node'

type Fn = Extract<Statement, { form: 'function' }>

// one command of a console, flattened: its path (`base init`), its takes, and the task its hook binds
export type Command = { path: string; takes: DockTake[]; task?: string; passes: boolean }

export type Drop = { path: string; take: string; task: string; reason: string }

// a take as verb-pair and cli-coverage read it
export type TakeShape = {
  name: string
  kind: string
  positional: boolean
  list: boolean
  maybe: boolean
  choices: string[]
  short?: string
}

export type Console = { program: Program; commands: Command[] }

// the console file as `term make` reads it: its role and its lean surface, through the project's resolver
export function readConsole(file: string, root: string): Console {
  // `optimize: false` is the editor's path: the CHECKED program, before the simplifier inlines a verbatim forwarder
  // (ir/simplifying.tree forwarder-target) and folds a read away, so every call site a wrapper wrote is still there
  const result = compile(
    { file, text: readFileSync(file, 'utf8') },
    { resolve: projectResolver(root), roleOf: projectRoleOf(root), leanOf: projectLeanOf(root), optimize: false },
  )

  if (!result.ok) {
    const first = result.diagnostics.slice(0, 3).map(d => d.message).join('; ')

    throw new Error(`${file} does not compile: ${first}`)
  }

  const commands: Command[] = []
  const walk = (route: DockRoute, parent?: string): void => {
    const path = parent ? `${parent} ${route.path}` : route.path
    commands.push({ path, takes: route.takes, task: route.calls[0]?.name, passes: route.passes === true })

    for (const kid of route.children ?? []) {
      walk(kid, path)
    }
  }

  // the console is one program hook: its takes are the global options, read by the console itself, never a task's
  for (const route of programOf(commandRoutes(result.program)).commands) {
    walk(route)
  }

  return { program: result.program, commands }
}

// the parameter each take of a route reaches, as the dispatcher fills them: a parameter takes the take of its own name,
// else the take at its position. Undefined for a take no parameter receives
function reachedParams(takes: DockTake[], params: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const names = new Set(takes.map(take => take.name))

  params.forEach((param, index) => {
    if (names.has(param)) {
      out.set(param, param)
    } else {
      const at = takes[index]

      if (at !== undefined && !out.has(at.name)) {
        out.set(at.name, param)
      }
    }
  })

  return out
}

// Why a parameter of a function counts as unread, or undefined when something reads it. A read that only hands the
// parameter, as is, to another function of the program is followed: the parameter is read when that function reads
// its own parameter there
export class Reach {
  private functions = new Map<string, Fn>()
  private memo = new Map<string, string | undefined>()

  constructor(program: Program) {
    for (const s of program) {
      if (s.form === 'function') {
        this.functions.set(s.name, s)
      }
    }
  }

  has(name: string): boolean {
    return this.functions.has(name)
  }

  paramsOf(name: string): string[] {
    return this.functions.get(name)?.params.map(p => p.name) ?? []
  }

  unread(fn: string, param: string, visiting = new Set<string>()): string | undefined {
    const key = `${fn}\u0000${param}`

    if (this.memo.has(key)) {
      return this.memo.get(key)
    }

    // a cycle reads nothing new: it is not a read by itself
    if (visiting.has(key)) {
      return `${fn} never reads it`
    }

    visiting.add(key)
    const answer = this.compute(fn, param, visiting)
    visiting.delete(key)
    this.memo.set(key, answer)

    return answer
  }

  private compute(fn: string, param: string, visiting: Set<string>): string | undefined {
    const found = this.functions.get(fn)

    if (!found) {
      return `${fn} is not in the program`
    }

    const reached = reachStatements(found.body, ['span', 'type'])
    let reads = 0

    for (const one of reached.expressions as Expression[]) {
      if (one.form === 'variable' && one.name === param && one.binding?.kind === 'parameter') {
        reads++
      }
    }

    if (reads === 0) {
      return `${fn} never reads it`
    }

    // the reads that hand the parameter whole to a function of the program
    const handed: { callee: string; target: string }[] = []

    for (const one of reached.expressions as Expression[]) {
      if (one.form !== 'call' || one.callee.form !== 'variable' || one.callee.binding?.kind !== 'function') {
        continue
      }

      const callee = one.callee.name

      if (!this.functions.has(callee)) {
        continue
      }

      const params = this.paramsOf(callee)

      one.args.forEach((arg, index) => {
        if (arg.form !== 'variable' || arg.name !== param || arg.binding?.kind !== 'parameter') {
          return
        }

        const named = one.names?.[index]
        const target = named ? named : params[index]

        if (target !== undefined) {
          handed.push({ callee, target })
        }
      })
    }

    // read somewhere else in the body: a read of its own
    if (handed.length < reads) {
      return undefined
    }

    const reasons: string[] = []

    for (const { callee, target } of handed) {
      const why = this.unread(callee, target, visiting)

      if (why === undefined) {
        return undefined
      }

      reasons.push(why)
    }

    return [...new Set(reasons)].join(', ')
  }
}

// every dropped take of every command of a console
export function dropsOf(console_: Console): Drop[] {
  const reach = new Reach(console_.program)
  const drops: Drop[] = []

  for (const command of console_.commands) {
    if (command.takes.length === 0) {
      continue
    }

    if (command.task === undefined) {
      for (const take of command.takes) {
        drops.push({ path: command.path, take: take.name, task: '(none)', reason: 'the hook binds no task' })
      }

      continue
    }

    const task = command.task

    if (!reach.has(task)) {
      for (const take of command.takes) {
        drops.push({ path: command.path, take: take.name, task, reason: `${task} is not in the program` })
      }

      continue
    }

    const reached = reachedParams(command.takes, reach.paramsOf(task))

    for (const take of command.takes) {
      const param = reached.get(take.name)

      if (param === undefined) {
        drops.push({ path: command.path, take: take.name, task, reason: `${task} has no parameter for it` })
        continue
      }

      const why = reach.unread(task, param)

      if (why !== undefined) {
        drops.push({ path: command.path, take: take.name, task, reason: why })
      }
    }
  }

  return drops
}

export function dropLine(drop: Drop): string {
  return `dropped: ${drop.path} --${drop.take} (${drop.reason})`
}

export function shapeOf(take: DockTake): TakeShape {
  // a maybe take is the named type `maybe` applied to its item (decision cli-in-term/008 part 1)
  const type = take.type as { kind?: string; name?: string; args?: { kind?: string }[] } | undefined
  const maybe = type?.kind === 'named' && type.name === 'maybe'
  const inner = maybe ? type?.args?.[0] : type
  const list = take.variadic === true || inner?.kind === 'array'
  const kind = inner?.kind === 'string' || inner?.kind === undefined ? 'text' : inner.kind

  return {
    name: take.name,
    kind,
    positional: take.positional === true,
    list,
    maybe,
    choices: take.choices ?? [],
    short: take.short,
  }
}

function main(): void {
  const term = process.cwd()
  const at = process.argv.indexOf('--file')
  const file = at === -1 ? join(term, 'deck/call/code/line/base.tree') : resolve(process.argv[at + 1] as string)
  const console_ = readConsole(file, at === -1 ? term : dirname(file))

  if (process.argv.includes('--routes')) {
    process.stdout.write(
      `${JSON.stringify(
        console_.commands.map(command => ({
          path: command.path,
          task: command.task,
          passes: command.passes,
          takes: command.takes.map(shapeOf),
        })),
      )}\n`,
    )

    return
  }

  const drops = dropsOf(console_)

  for (const drop of drops) {
    console.log(dropLine(drop))
  }

  console.log(`take-reach: ${drops.length} dropped`)

  if (drops.length > 0) {
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
