// A write a task makes through a record parameter reaches somebody.
//
// A form's value is a value on every backend: a task handed a record writes its own copy (Rust and Swift pass a
// struct, TypeScript passes a spread since D1, codegen-performance-0028). So `bump` below changed nothing its caller
// could see, and nothing said so (guides: parsers/cursor, 2026-10-03):
//
//   task bump
//     take box, like counter
//     save box/count, add(box/count, 1)
//
// The write is lost exactly when the task gives back nothing and nothing reads that parameter after the write: there
// is no way out for the copy. That is refused here, naming the two fixes: send the record back, or make the form
// `mark shared`, one object every binding sees. A task that reads its copy after writing it (to compute a value, or
// in a `hold` about it) is using the copy, and is left alone.

import type { Program, Statement, Type } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

type Task = Extract<Statement, { form: 'function' }>

function returnsNothing(task: Task): boolean {
  const result = task.result

  return (
    result === undefined ||
    result.kind === 'unit' ||
    (result.kind === 'named' && (result.name === 'void' || result.name === 'unit'))
  )
}

// a written field path, `box/inner/count`, as its root parameter and the fields read on the way to the one written
// (`inner`), or nothing when the target is not a plain field path
function writtenPath(target: unknown): { root: string; through: string[] } | undefined {
  let node = target as { form?: string; target?: unknown; name?: string; index?: unknown }

  if (node?.form !== 'member' || node.index) {
    return undefined
  }

  const names: string[] = []

  while (node?.form === 'member') {
    names.unshift(node.name ?? '')
    node = node.target as typeof node
  }

  return node?.form === 'variable' && node.name ? { root: node.name, through: names.slice(0, -1) } : undefined
}

export function checkLostWrites(program: Program, file: string): Diagnostic[] {
  const shared = new Set<string>()
  const forms = new Map<string, Map<string, Type>>()

  for (const s of program) {
    if (s.form === 'record-type') {
      forms.set(s.name, new Map(s.fields.map(f => [f.name, f.type])))

      if (s.shared) {
        shared.add(s.name)
      }
    }
  }

  // The write stays inside the copy only while every container on its path is a value form. A path through a field
  // that is not one (an opaque `link handle, mark private`, a `mark shared` form, a list or a hash) reaches an object
  // the caller holds too: `save node/handle/text, read value` on a view writes the one element both bindings name
  const staysInCopy = (form: string, through: string[]): boolean => {
    let current = form

    for (const name of through) {
      const type = forms.get(current)?.get(name)

      if (type?.kind !== 'named' || !forms.has(type.name) || shared.has(type.name)) {
        return false
      }

      current = type.name
    }

    return true
  }

  const out: Diagnostic[] = []

  for (const task of program) {
    if (task.form !== 'function' || task.span.file !== file || task.body.length === 0 || !returnsNothing(task)) {
      continue
    }

    // the record parameters of a value form
    const values = new Map<string, string>()

    task.params.forEach((param, i) => {
      const type = (task.declared?.params[i] ?? param.type) as Type | undefined

      if (type?.kind === 'named' && forms.has(type.name) && !shared.has(type.name)) {
        values.set(param.name, type.name)
      }
    })

    if (values.size === 0) {
      continue
    }

    // In source order: the first write to each parameter's copy, and the last place each parameter is read. An
    // assignment's value is read before its write lands (`save box/count, add(box/count, 1)` reads the old count), so
    // it is visited first. A copy read after it was written is in use (a `hold` on it, or a value computed from it),
    // and only a write nothing reads afterwards is lost
    const firstWrite = new Map<string, { at: number; span: Diagnostic['span'] }>()
    const lastRead = new Map<string, number>()
    let clock = 0

    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') {
        return
      }

      if (Array.isArray(node)) {
        node.forEach(visit)

        return
      }

      const record = node as Record<string, unknown>

      // a closure or a nested task has parameters of its own
      if (record.form === 'closure' || record.form === 'function') {
        return
      }

      if (record.form === 'assign') {
        visit(record.value)

        const path = writtenPath(record.target)
        const root = path?.root

        if (path && root !== undefined && values.has(root) && staysInCopy(values.get(root)!, path.through)) {
          if (!firstWrite.has(root)) {
            firstWrite.set(root, { at: clock, span: record.span as Diagnostic['span'] })
          }
        } else {
          visit(record.target)
        }

        clock++

        return
      }

      if (record.form === 'variable' && typeof record.name === 'string' && values.has(record.name)) {
        lastRead.set(record.name, clock)
      }

      clock++

      for (const [key, child] of Object.entries(record)) {
        if (key !== 'span' && key !== 'type') {
          visit(child)
        }
      }
    }

    visit(task.body)

    for (const [root, write] of firstWrite) {
      if ((lastRead.get(root) ?? -1) > write.at) {
        continue
      }

      out.push(
        diagnose('type-mismatch', {
          file,
          span: write.span,
          message: `this writes \`${root}\`'s own copy: a ${values.get(root)} is a value, and \`${task.method?.name ?? task.name}\` sends nothing back, so the caller never sees the change`,
          hint: `send \`${root}\` back and use what comes back, or make \`${values.get(root)}\` \`mark shared\` so every binding sees one object`,
        }),
      )
    }
  }

  return out
}

// A WRITE TO A LIST OR HASH PARAMETER that the caller never sees (self-hosting-0026, D1, the first of the three
// value-semantics patterns in note/term/self-host/06-the-rust-emitter.md). A list and a hash are values under D1: a task
// handed one has its own. Every backend still shares the caller's collection today (a JavaScript array, an
// `Rc<RefCell<Vec>>`), so `fill` below grows the caller's list now and stops doing so the day the collection is a
// value, without a word:
//
//   task fill
//     take xs, like list, like number
//     push(xs, 1)
//
// It is found the way a record write is: a task that sends nothing back writes a collection parameter and never reads
// it afterwards. A write is a native mutator called on it (`xs/push(1)`, `m/set(k, v)`), an indexed assignment
// (`save xs/{i}, v`), or the parameter handed to a task that writes the parameter in that position, found to a fixed
// point over the program, so a stdlib `push(xs, x)` counts. WARNED, not refused, until the corpus is clean: each one is
// a place that relies on two names sharing one collection

// the native methods that change a list or a native map in place
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'delete', 'clear'])

const isCollection = (type: Type | undefined): boolean => type?.kind === 'array' || type?.kind === 'map'

type Loose = Record<string, unknown> & { form?: string }

// the root variable of an indexed write, `save xs/{i}, v` (`xs/0` is a member with a literal index)
function indexedRoot(target: unknown): string | undefined {
  const node = target as Loose

  if (node?.form !== 'member' || !node.index) {
    return undefined
  }

  const inner = node.target as Loose

  return inner?.form === 'variable' && typeof inner.name === 'string' ? inner.name : undefined
}

// for each task, the positions of the parameters it writes: directly, or by handing them to a task that does
export function collectionWrites(program: Program): Map<Task, Set<number>> {
  const tasks = program.filter((s): s is Task => s.form === 'function' && s.body.length > 0)
  const byName = new Map<string, Task[]>()

  for (const task of tasks) {
    byName.set(task.name, [...(byName.get(task.name) ?? []), task])
  }

  const writes = new Map<Task, Set<number>>(tasks.map(task => [task, new Set<number>()]))
  let changed = true

  while (changed) {
    changed = false

    for (const task of tasks) {
      const positions = new Map(task.params.map((param, i) => [param.name, i]))
      const found = writes.get(task)!
      const mark = (name: string): void => {
        const at = positions.get(name)

        if (at !== undefined && !found.has(at)) {
          found.add(at)
          changed = true
        }
      }

      eachWrite(task.body, byName, writes, mark)
    }
  }

  return writes
}

// every write in `node` to a variable, by its name: a mutator called on it, an indexed assignment, or the variable
// handed to a task that writes that position. `read` sees every other read of a variable, in source order
function eachWrite(
  node: unknown,
  byName: Map<string, Task[]>,
  writes: Map<Task, Set<number>>,
  write: (name: string, span: unknown) => void,
  read: (name: string) => void = () => {},
): void {
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const record = value as Loose

    // a closure or a nested task has parameters of its own
    if (record.form === 'closure' || record.form === 'function') {
      return
    }

    if (record.form === 'call') {
      const callee = record.callee as Loose
      const args = (record.args as unknown[]) ?? []
      const receiver = callee?.form === 'member' ? (callee.target as Loose) : undefined

      // `xs/push(1)`: the receiver is written, not read
      if (receiver?.form === 'variable' && typeof receiver.name === 'string' && MUTATORS.has(callee.name as string)) {
        visit(args)
        write(receiver.name, record.span)

        return
      }

      // `push(xs, 1)`: a variable in a position the callee writes
      if (callee?.form === 'variable' && typeof callee.name === 'string') {
        const defs = (byName.get(callee.name) ?? []).filter(def => def.params.length === args.length)

        args.forEach((arg, i) => {
          const one = arg as Loose

          if (one?.form === 'variable' && typeof one.name === 'string' && defs.some(def => writes.get(def)?.has(i))) {
            write(one.name, record.span)
          } else {
            visit(arg)
          }
        })

        return
      }
    }

    if (record.form === 'assign') {
      visit(record.value)

      const root = indexedRoot(record.target)

      if (root !== undefined) {
        visit((record.target as Loose).index)
        write(root, record.span)
      } else {
        visit(record.target)
      }

      return
    }

    if (record.form === 'variable' && typeof record.name === 'string') {
      read(record.name)
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(child)
      }
    }
  }

  visit(node)
}

export function warnLostCollectionWrites(program: Program, file: string): Diagnostic[] {
  const writes = collectionWrites(program)
  const byName = new Map<string, Task[]>()

  for (const task of writes.keys()) {
    byName.set(task.name, [...(byName.get(task.name) ?? []), task])
  }

  const out: Diagnostic[] = []

  for (const [task, positions] of writes) {
    if (task.span.file !== file || !returnsNothing(task) || positions.size === 0) {
      continue
    }

    // the collection parameters it writes
    const written = new Set(
      task.params
        .filter((param, i) => positions.has(i) && isCollection((task.declared?.params[i] ?? param.type) as Type | undefined))
        .map(param => param.name),
    )

    if (written.size === 0) {
      continue
    }

    // in source order: the first write to each, and the last read of each. A copy read after it was written is in use
    const firstWrite = new Map<string, { at: number; span: unknown }>()
    const lastRead = new Map<string, number>()
    let clock = 0

    eachWrite(
      task.body,
      byName,
      writes,
      (name, span) => {
        clock++

        if (written.has(name) && !firstWrite.has(name)) {
          firstWrite.set(name, { at: clock, span })
        }
      },
      name => {
        clock++

        if (written.has(name)) {
          lastRead.set(name, clock)
        }
      },
    )

    for (const [name, write] of firstWrite) {
      if ((lastRead.get(name) ?? -1) > write.at) {
        continue
      }

      out.push({
        ...diagnose('type-mismatch', {
          file,
          span: write.span as Diagnostic['span'],
          message: `this writes \`${name}\`, a collection \`${task.method?.name ?? task.name}\` was handed and sends nothing back: under value semantics (D1) the write reaches a copy the caller never sees`,
          hint: `send \`${name}\` back and use what comes back, or hold it in a \`mark shared\` form so every binding sees one object`,
        }),
        severity: 'warning',
      })
    }
  }

  return out
}
