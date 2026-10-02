// What can be refused about a `twin` without running anything (note/term/optimize/admission.md, optimize-0006).
//
// A twin is another implementation of a named task that the compiler may choose in its place. Before any test or
// proof asks whether it AGREES with the task, these ask whether it COULD: does the task exist and is it pure, does
// the twin take the task's parameters, is it pure and does it end where the task does, are its run-time checks pure,
// does it ask for a relaxation Term defines, and do no two twins call each other's tasks in a cycle.
//
// Each twin is checked as a synthetic task with the reference's parameters, appended to a copy of the program, so
// purity and termination come from the same analyses every other task goes through (facts.ts, totality.ts) rather
// than from a second opinion written here.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Expression, Program, Statement, Twin } from '@term/make/code/compile/node'
import { pureFunctions } from '@term/make/code/check/facts'
import { terminatingFunctions } from '@term/make/code/check/totality'

type Fn = Extract<Statement, { form: 'function' }>

// the relaxations Term defines, each with its decision procedure in note/term/optimize/words.md
export const EASE = new Set(['float-order', 'float-fused'])

// the internal name a twin's body is checked under. Not a name a person can write: `:` is not a word character
export function twinTaskName(twin: Twin): string {
  return `twin:${twin.of}:${twin.name}`
}

// every task a body calls by name
function calleesOf(body: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(body)) {
    for (const item of body) {
      calleesOf(item, into)
    }

    return into
  }

  if (body === null || typeof body !== 'object') {
    return into
  }

  const node = body as { form?: string; callee?: { form?: string; name?: string } }

  if (node.form === 'call' && node.callee?.form === 'variable' && node.callee.name) {
    into.add(node.callee.name)
  }

  for (const [key, value] of Object.entries(body)) {
    if (key !== 'span' && key !== 'type') {
      calleesOf(value, into)
    }
  }

  return into
}

export function checkTwins(program: Program, twins: Twin[], file: string): Diagnostic[] {
  if (twins.length === 0) {
    return []
  }

  const diagnostics: Diagnostic[] = []
  const tasks = new Map<string, Fn>()

  for (const statement of program) {
    if (statement.form === 'function' && !statement.method) {
      tasks.set(statement.name, statement)
    }
  }

  const refuse = (
    name: Parameters<typeof diagnose>[0],
    twin: Twin,
    message: string,
  ): void => {
    diagnostics.push(diagnose(name, { file: twin.span.file ?? file, span: twin.span, message }))
  }

  // the twins that can be checked further, each as a synthetic task, and its guards as tasks of their own
  const synthetic: Fn[] = []
  const guards = new Map<string, Twin>()
  const checked: Twin[] = []

  for (const twin of twins) {
    const task = tasks.get(twin.of)

    if (!task) {
      refuse('twin-unknown', twin, `\`twin ${twin.of}, name ${twin.name}\`: there is no task \`${twin.of}\` here`)
      continue
    }

    const expected = task.params.map(p => p.name)

    if (expected.join(',') !== twin.params.join(',')) {
      refuse(
        'twin-signature',
        twin,
        `\`${twin.name}\` takes ${twin.params.length ? twin.params.join(', ') : 'nothing'}, and \`${twin.of}\` takes ${expected.length ? expected.join(', ') : 'nothing'}`,
      )
      continue
    }

    for (const ease of twin.ease) {
      if (!EASE.has(ease)) {
        refuse('ease-unknown', twin, `\`ease ${ease}\` is not a relaxation Term defines: ${[...EASE].join(', ')}`)
      }
    }

    synthetic.push({
      ...task,
      name: twinTaskName(twin),
      // the knobs are compile-time values, bound like parameters for the checks
      params: [...task.params, ...twin.knobs.map(k => ({ name: k.name, ...(k.type ? { type: k.type } : {}) }))],
      body: twin.body,
      span: twin.span,
    } as Fn)

    twin.test.forEach((test: Expression, i: number) => {
      const name = `${twinTaskName(twin)}:test:${i}`
      guards.set(name, twin)
      synthetic.push({
        ...task,
        name,
        result: { kind: 'boolean' },
        body: [{ form: 'return', value: test, span: test.span }],
        span: test.span,
      } as Fn)
    })

    checked.push(twin)
  }

  if (checked.length > 0) {
    const all: Program = [...program, ...synthetic]
    const pure = pureFunctions(all)
    const ending = terminatingFunctions(all)
    const bodies = new Map<string, unknown>()

    for (const statement of all) {
      if (statement.form === 'function') {
        bodies.set(statement.name, statement.body)
      }
    }

    // a task and every task it can reach through calls, the task first
    const reachable = (start: string): string[] => {
      const seen = new Set<string>([start])
      const queue = [start]

      while (queue.length > 0) {
        for (const callee of calleesOf(bodies.get(queue.shift()!))) {
          if (bodies.has(callee) && !seen.has(callee)) {
            seen.add(callee)
            queue.push(callee)
          }
        }
      }

      return [...seen]
    }

    for (const twin of checked) {
      const name = twinTaskName(twin)

      if (!pure.has(twin.of)) {
        refuse(
          'twin-of-impure',
          twin,
          `\`${twin.of}\` is not pure, so \`${twin.name}\` would have to repeat its effects in the same order`,
        )
        continue
      }

      if (!twin.trust && !pure.has(name)) {
        refuse('twin-impure', twin, `\`${twin.name}\` is not pure: say \`note trust\` to admit it as trusted, or make it pure`)
      }

      // the totality checker judges a task by its OWN recursion, so a twin ends only if it and every task it can
      // reach are each shown to end: a twin calling a task that spins forever spins forever too
      const stuck = reachable(name).find(task => !ending.has(task))

      if (ending.has(twin.of) && stuck !== undefined) {
        refuse(
          'twin-loops',
          twin,
          stuck === name
            ? `\`${twin.of}\` is shown to end and \`${twin.name}\` is not`
            : `\`${twin.of}\` is shown to end and \`${twin.name}\` calls \`${stuck}\`, which is not`,
        )
      }
    }

    for (const [guard, twin] of guards) {
      if (!pure.has(guard)) {
        refuse('guard-impure', twin, `a \`hook test\` of \`${twin.name}\` is not pure`)
      }
    }
  }

  // a cycle through twins: a twin of A calls B, and a twin of B calls A (directly or further round). A twin calling
  // its OWN task is not a cycle here: it is how a twin falls back to the reference, and the selection pass never
  // replaces a call to a task inside that task's own twins
  const edges = new Map<string, Set<string>>()

  for (const twin of checked) {
    const out = edges.get(twin.of) ?? new Set<string>()

    for (const callee of calleesOf(twin.body)) {
      if (callee !== twin.of && twins.some(t => t.of === callee)) {
        out.add(callee)
      }
    }

    edges.set(twin.of, out)
  }

  const reported = new Set<string>()

  for (const start of edges.keys()) {
    const path: string[] = []
    const onPath = new Set<string>()

    const walk = (at: string): string[] | undefined => {
      if (onPath.has(at)) {
        return path.slice(path.indexOf(at))
      }

      path.push(at)
      onPath.add(at)

      for (const next of edges.get(at) ?? []) {
        const cycle = walk(next)

        if (cycle) {
          return cycle
        }
      }

      path.pop()
      onPath.delete(at)

      return undefined
    }

    const cycle = walk(start)

    if (cycle) {
      const key = [...cycle].sort().join(',')

      if (!reported.has(key)) {
        reported.add(key)
        const twin = checked.find(t => t.of === cycle[0])!
        refuse('twin-cycle', twin, `twins of ${cycle.join(' -> ')} -> ${cycle[0]} call each other`)
      }
    }
  }

  return diagnostics
}
