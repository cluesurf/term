// The selection pass (note/term/optimize/pipeline.md, optimize-0008): put a CHOSEN implementation of a task behind
// every call to it, for one target. A choice is the reference, a twin's label, or a size check that splits two
// choices. It comes from a pin (`bake.json`, optimize-0014) or from the caller of compile(); with none, nothing here
// runs and every build is the reference, which is always correct.
//
// What it writes, as ordinary Term that every backend already emits:
//
//   <task>-twin-<label>   each chosen twin, as a task with the reference's parameters, result, generics and raise bound
//   <task>-chosen         the dispatch: the choice, with a twin's `hook test` checked at run time and the reference
//                         taken when it fails, and a size check as a branch on a list's length
//
// and every call to <task> outside the reference, its twins and the dispatch now calls <task>-chosen. A twin calling
// its own task reaches the REFERENCE, never itself, which is how a twin falls back for the inputs it does not handle.
//
// It runs BEFORE names are bound and types checked, so the twins and the dispatch are checked like any task.
//
// Refused, with the reason, rather than guessed at: a twin whose `have` would have to be proven at each call site (the
// prover is not consulted here yet), a twin that needs a relaxation the caller must grant (`ease`), and a twin with
// knobs (a `tour` chooses those, optimize-0026). A chosen twin must also be eligible on this target (`mark platform`).

import type { Expression, Program, Statement, Twin } from '@term/make/code/compile/node'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { ZERO_SPAN as ZERO } from '@term/make/code/compile/mill-run'

type Fn = Extract<Statement, { form: 'function' }>

// one task's choice for this target
export type TwinChoice =
  // the task as written
  | 'reference'
  // a twin, by label
  | { use: string }
  // the first choice below `below` items in the named list parameter, the second from there on
  | { check: 'size'; of: string; below: number; then: TwinChoice; else: TwinChoice }

// task name -> its choice
export type TwinChoices = Record<string, TwinChoice>

export const twinTask = (task: string, label: string): string => `${task}-twin-${label}`
export const chosenTask = (task: string): string => `${task}-chosen`

// the targets a twin's `mark platform, name <x>` can name, and the build environments each covers
const PLATFORM_ENVS: Record<string, string[]> = {
  typescript: ['node', 'browser', 'cloudflare', 'webview', 'javascript', 'typescript'],
  rust: ['rust'],
  swift: ['swift'],
  kotlin: ['kotlin'],
}

function eligibleOn(twin: Twin, env: string | undefined): boolean {
  if (twin.platform.length === 0) {
    return true
  }

  const target = env ?? 'typescript'

  return twin.platform.some(p => (PLATFORM_ENVS[p] ?? [p]).includes(target))
}

function labelsOf(choice: TwinChoice): string[] {
  if (choice === 'reference') {
    return []
  }

  if ('use' in choice) {
    return [choice.use]
  }

  return [...labelsOf(choice.then), ...labelsOf(choice.else)]
}

// rewrite every call to `from` (in callee position) to call `to`
function redirect(node: unknown, from: string, to: string): void {
  if (Array.isArray(node)) {
    node.forEach(item => redirect(item, from, to))

    return
  }

  if (node === null || typeof node !== 'object') {
    return
  }

  const n = node as { form?: string; callee?: { form?: string; name?: string } }

  if (n.form === 'call' && n.callee?.form === 'variable' && n.callee.name === from) {
    n.callee.name = to
  }

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'span' && key !== 'type') {
      redirect(value, from, to)
    }
  }
}

export function applyTwins(
  program: Program,
  twins: Twin[],
  choices: TwinChoices,
  env: string | undefined,
  file: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const tasks = new Map<string, Fn>()

  for (const statement of program) {
    if (statement.form === 'function' && !statement.method) {
      tasks.set(statement.name, statement)
    }
  }

  const refuse = (span: Span, message: string): void => {
    diagnostics.push(diagnose('twin-choice', { file: span.file ?? file, span, message }))
  }

  const added: Fn[] = []
  const redirects: [string, string, Set<string>][] = []

  for (const [task, choice] of Object.entries(choices)) {
    const reference = tasks.get(task)

    if (!reference) {
      refuse({ ...ZERO, file }, `a choice names \`${task}\`, and there is no such task`)
      continue
    }

    const used = new Map<string, Twin>()
    let bad = false

    for (const label of new Set(labelsOf(choice))) {
      const twin = twins.find(t => t.of === task && t.name === label)

      if (!twin) {
        refuse(reference.span, `a choice for \`${task}\` names the twin \`${label}\`, and \`${task}\` has none of that name`)
        bad = true
      } else if (!eligibleOn(twin, env)) {
        refuse(twin.span, `\`${task}/${label}\` is not eligible on ${env ?? 'typescript'} (\`mark platform\` names ${twin.platform.join(', ')})`)
        bad = true
      } else if (twin.have.length > 0) {
        refuse(twin.span, `\`${task}/${label}\` has a \`have\`, which must be proven at each call site, and the selection pass does not consult the prover yet: write the condition as a \`hook test\` to have it checked at run time`)
        bad = true
      } else if (twin.ease.length > 0) {
        refuse(twin.span, `\`${task}/${label}\` needs \`ease ${twin.ease.join(', ')}\`, which only the calling task can grant, and the selection pass does not read grants yet`)
        bad = true
      } else if (twin.knobs.length > 0) {
        refuse(twin.span, `\`${task}/${label}\` has knobs, which a \`tour\` chooses (optimize-0026)`)
        bad = true
      } else {
        used.set(label, twin)
      }
    }

    // a size check names a list parameter of the task
    const sizes = (c: TwinChoice): string[] =>
      c === 'reference' || 'use' in c ? [] : [c.of, ...sizes(c.then), ...sizes(c.else)]

    for (const param of sizes(choice)) {
      if (!reference.params.some(p => p.name === param)) {
        refuse(reference.span, `a size check for \`${task}\` reads \`${param}\`, which is not one of its parameters`)
        bad = true
      }
    }

    if (bad) {
      continue
    }

    const span = reference.span
    const variable = (name: string): Expression => ({ form: 'variable', name, span })
    const callOf = (name: string): Expression => ({
      form: 'call',
      callee: variable(name),
      args: reference.params.map(p => variable(p.name)),
      span,
    })
    const returning = (name: string): Statement[] => [{ form: 'return', value: callOf(name), span }]

    // the statements that compute the choice and return it
    const body = (c: TwinChoice): Statement[] => {
      if (c === 'reference') {
        return returning(task)
      }

      if ('use' in c) {
        const twin = used.get(c.use)!

        if (twin.test.length === 0) {
          return returning(twinTask(task, c.use))
        }

        // every `hook test` holds, or the reference answers
        const cond = twin.test
          .map(t => structuredClone(t))
          .reduce((a, b): Expression => ({ form: 'binary', op: '&&', left: a, right: b, span }))

        return [{ form: 'if', branches: [{ cond, body: returning(twinTask(task, c.use)) }], otherwise: returning(task), span }]
      }

      const cond: Expression = {
        form: 'binary',
        op: '<',
        left: { form: 'member', target: variable(c.of), name: 'length', span },
        right: { form: 'integer', value: c.below, span },
        span,
      }

      return [{ form: 'if', branches: [{ cond, body: body(c.then) }], otherwise: body(c.else), span }]
    }

    // the twins as tasks: the reference's signature, the twin's body, no contract of their own
    const { have: _have, must: _must, down: _down, ...signature } = reference as Fn & { have?: unknown; must?: unknown; down?: unknown }

    for (const [label, twin] of used) {
      added.push({ ...structuredClone(signature), name: twinTask(task, label), body: structuredClone(twin.body), span: twin.span } as Fn)
    }

    added.push({ ...structuredClone(signature), name: chosenTask(task), body: body(choice), span } as Fn)

    // every call to the task now goes through the dispatch, except inside the reference, its twins and the dispatch
    redirects.push([task, chosenTask(task), new Set([task, chosenTask(task), ...[...used.keys()].map(l => twinTask(task, l))])])
  }

  program.push(...added)

  for (const [from, to, keep] of redirects) {
    for (const statement of program) {
      if (statement.form === 'function' && keep.has(statement.name)) {
        continue
      }

      redirect(statement, from, to)
    }
  }

  return diagnostics
}
