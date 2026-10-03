// F4, the first text fact (note/term/codegen/shared.md): which text expressions are ASCII. A Term text counts code
// points (note/term/stdlib/semantics.md), so `char-at(s, i)` must walk `s` from its start on Rust (`chars().nth(i)`),
// Swift and Kotlin (`offsetByCodePoints`): O(i) per read, O(n^2) over a loop. On ASCII text a code point is one byte
// and one UTF-16 unit, so the same read is a direct index on every backend. fasta-redux built each line by appending
// `char-at` of a 287-character text and hashed it with `char-code-at`: Rust 4.74 and Swift 7.65 of the hand versions.
//
// A text expression is ASCII when it is
//   - a literal with no character above 127
//   - a template whose text parts are ASCII and whose other parts are numbers or flags (printed in ASCII)
//   - `char-at`, `at`, `substring`, `slice`, `to-lower-case`, `to-upper-case`, a trim, or `repeat` of an ASCII text,
//     and `concat` or a pad of two ASCII texts
//   - a call to a task whose every `send back` is ASCII
//   - a local every value of which is ASCII, or a parameter every call site passes ASCII
// Solved optimistically for every local, parameter and task, and dropped until stable. A task never called, or used as
// a value, takes no fact for its parameters: a caller the program cannot see may pass anything.
//
// The answer is every text-typed expression node proven ASCII, keyed by identity like every fact: an emitter that
// ignores it stays correct.

import type { Program, Statement } from '../../compile/node'

type Loose = { form?: string; [key: string]: unknown }
type Fn = Extract<Statement, { form: 'function' }>

const ASCII = /^[\x00-\x7f]*$/
const isText = (t: unknown): boolean => (t as { kind?: string } | undefined)?.kind === 'string'
const printsAscii = (t: unknown): boolean => ['number', 'float', 'boolean'].includes((t as { kind?: string } | undefined)?.kind ?? '')

// the string methods whose answer is ASCII when their receiver is (and, for two-text ones, their argument)
const KEEPS = new Set(['charAt', 'at', 'substring', 'slice', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'repeat'])
const JOINS = new Set(['concat', 'padStart', 'padEnd'])
const HOST: Record<string, string> = {
  'char-at': 'charAt',
  'to-lower-case': 'toLowerCase',
  'to-upper-case': 'toUpperCase',
  'trim-start': 'trimStart',
  'trim-end': 'trimEnd',
  'pad-start': 'padStart',
  'pad-end': 'padEnd',
}
const method = (name: string): string => HOST[name] ?? name

export function asciiTexts(program: Program): WeakSet<object> {
  const fns = program.filter((n): n is Fn => n.form === 'function')
  const byName = new Map<string, Fn[]>()

  for (const fn of fns) {
    byName.set(fn.name, [...(byName.get(fn.name) ?? []), fn])
  }

  // optimistic: every task's text parameters and text result ASCII, every text local ASCII
  const params = new Map<string, Set<number>>()
  const results = new Set<string>()
  const locals = new Map<Fn, Set<string>>()
  const called = new Set<string>()
  const asValue = new Set<string>()

  const walk = (value: unknown, see: (node: Loose, parent: Loose | undefined, key: string) => void, parent?: Loose, key = ''): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => walk(v, see, parent, key))

      return
    }

    const node = value as Loose
    see(node, parent, key)

    for (const [k, child] of Object.entries(node)) {
      if (k !== 'type' && k !== 'span') {
        walk(child, see, node, k)
      }
    }
  }

  walk(program, (node, parent, key) => {
    if (node.form === 'variable' && byName.has(node.name as string)) {
      if (parent?.form === 'call' && key === 'callee') {
        called.add(node.name as string)
      } else {
        asValue.add(node.name as string)
      }
    }
  })

  for (const fn of fns) {
    const unique = byName.get(fn.name)!.length === 1 && called.has(fn.name) && !asValue.has(fn.name)
    params.set(fn.name, new Set(unique ? fn.params.flatMap((p, i) => (isText(p.type) ? [i] : [])) : []))

    if (isText(fn.result)) {
      results.add(fn.name)
    }

    const names = new Set<string>()
    walk(fn.body, node => {
      if (node.form === 'let' && isText(node.type ?? (node.init as Loose).type)) {
        names.add(node.name as string)
      }
    })
    locals.set(fn, names)
  }

  // a name the task binds some other way (a walk's item, a closure's parameter, an arm's field) is never a fact
  const bound = (fn: Fn): Set<string> => {
    const found = new Set<string>()
    walk(fn.body, node => {
      if (node.form === 'for-each') {
        found.add(node.item as string)
      }

      if (node.form === 'closure') {
        for (const p of node.params as { name: string }[]) {
          found.add(p.name)
        }
      }

      if (node.form === 'match') {
        for (const c of node.cases as { binds?: string[] }[]) {
          for (const b of c.binds ?? []) {
            found.add(b)
          }
        }
      }
    })

    return found
  }

  const ascii = (e: Loose | undefined, fn: Fn, vars: Set<string>): boolean => {
    if (!e) {
      return false
    }

    switch (e.form) {
      case 'string':
        return ASCII.test(e.value as string)
      case 'template':
        return (e.parts as (string | Loose)[]).every(part =>
          typeof part === 'string' ? ASCII.test(part) : printsAscii(part.type) || ascii(part, fn, vars),
        )
      case 'variable':
        return vars.has(e.name as string)
      case 'conditional':
        return (
          (e.branches as { value: Loose }[]).every(b => ascii(b.value, fn, vars)) &&
          (e.otherwise === undefined || ascii(e.otherwise as Loose, fn, vars))
        )
      case 'call': {
        const callee = e.callee as Loose

        if (callee.form === 'member' && isText((callee.target as Loose).type)) {
          const op = method(callee.name as string)

          if (KEEPS.has(op)) {
            return ascii(callee.target as Loose, fn, vars)
          }

          if (JOINS.has(op)) {
            return ascii(callee.target as Loose, fn, vars) && (e.args as Loose[]).every(a => !isText(a.type) || ascii(a, fn, vars))
          }

          return false
        }

        return callee.form === 'variable' && results.has(callee.name as string)
      }
      default:
        return false
    }
  }

  // the ASCII names in scope in a task: its ASCII parameters and its ASCII locals, less any name bound another way
  const scope = (fn: Fn): Set<string> => {
    const out = new Set<string>()
    const mine = params.get(fn.name)!

    fn.params.forEach((p, i) => {
      if (mine.has(i)) {
        out.add(p.name)
      }
    })

    for (const name of locals.get(fn)!) {
      out.add(name)
    }

    for (const name of bound(fn)) {
      out.delete(name)
    }

    return out
  }

  for (let changed = true; changed; ) {
    changed = false

    for (const fn of fns) {
      const vars = scope(fn)
      const keep = locals.get(fn)!

      walk(fn.body, node => {
        // a local given a value that is not ASCII, by its `let` or any assignment
        const target = node.form === 'let' ? (node.name as string) : node.form === 'assign' && (node.target as Loose).form === 'variable' ? ((node.target as Loose).name as string) : undefined
        const value = node.form === 'let' ? (node.init as Loose) : (node.value as Loose)

        if (target !== undefined && keep.has(target) && !ascii(value, fn, vars)) {
          keep.delete(target)
          changed = true
        }

        // a parameter of a callee passed something that is not ASCII
        if (node.form === 'call' && (node.callee as Loose).form === 'variable') {
          const takes = params.get((node.callee as Loose).name as string)

          ;(node.args as Loose[]).forEach((arg, i) => {
            if (takes?.has(i) && !ascii(arg, fn, vars)) {
              takes.delete(i)
              changed = true
            }
          })
        }

        // a task handing back something that is not ASCII
        if (node.form === 'return' && results.has(fn.name) && !ascii(node.value as Loose, fn, vars)) {
          results.delete(fn.name)
          changed = true
        }
      })
    }
  }

  // every text-typed expression the solved facts prove ASCII
  const found = new WeakSet<object>()

  for (const fn of fns) {
    const vars = scope(fn)

    walk(fn.body, node => {
      if (node.form !== undefined && isText(node.type) && ascii(node, fn, vars)) {
        found.add(node)
      }
    })
  }

  return found
}
