// Which facts survive a statement, and which tasks are pure. Shared by the kernel's command checker (elaborate.ts) and
// the linear prover (holds.ts), so the two cannot disagree about it.
//
// Both provers keep path facts as expressions over NAMES (`x == 0`, `n > 0`). A surface name is not a mathematical
// variable: `save x` gives it a new value, a branch or a loop may have done so, a closure may do so whenever it is
// called, and a call to a task that writes through a record changes what `read b/size` means. A fact that outlives the
// value it was about proves false things, which is what this module exists to stop. See
// note/term/proof-by-default/semantics.md: in the pure core every assignment is a new name, so nothing is ever retracted.
// Until the core exists, retracting is how the surface provers get the same answer.
//
// The second half is purity. The kernel registers every task as a constant, so two calls with equal arguments are equal
// by construction. That is true of a pure task and false of one that reads a clock, a random source, a mutable global,
// or the world. A goal that mentions an impure call cannot be decided by either prover, and is left outside the fragment.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'

type Fn = Extract<Statement, { form: 'function' }>

// every object in a subtree, once each, in a generic walk that does not hard-code the AST's shape
function visit(root: unknown, see: (node: Record<string, unknown>) => void): void {
  const seen = new Set<unknown>()
  const stack: unknown[] = [root]

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) {
        stack.push(item)
      }

      continue
    }

    see(node as Record<string, unknown>)

    for (const key of Object.keys(node)) {
      // a resolved type annotation is not code, and walking it only costs time
      if (key === 'type' || key === 'result' || key === 'span') {
        continue
      }

      stack.push((node as Record<string, unknown>)[key])
    }
  }
}

// the variable a write lands in: `x` for `save x`, `b` for `save b/size` and `save b/{i}/size`. Undefined when the
// target is not rooted in a name, which callers treat as "anything may have changed".
export function rootName(target: Expression): string | undefined {
  let current: Expression = target

  while (current.form === 'member') {
    current = current.target
  }

  return current.form === 'variable' ? current.name : undefined
}

// the sentinel for a write whose root could not be named: every fact is dropped
export const EVERYTHING = '*'

// every name a subtree WRITES OR BINDS: assignment roots, `let` names (a rebinding in a loop or a shadowing in a
// branch is a new value under the old name), loop items and indexes, a handler's caught name, a closure's or a nested
// task's parameters. Over-approximating is sound: dropping a fact that was still true loses proving power, never truth.
export function writtenNames(subtree: unknown): Set<string> {
  const names = new Set<string>()

  visit(subtree, node => {
    switch (node.form) {
      case 'assign': {
        const root = rootName(node.target as Expression)
        names.add(root ?? EVERYTHING)
        break
      }
      case 'let':
        names.add(node.name as string)
        break
      case 'for-each':
        names.add(node.item as string)

        if (typeof node.index === 'string') {
          names.add(node.index)
        }

        break
      case 'closure':
      case 'function':
        for (const param of node.params as { name: string }[]) {
          names.add(param.name)
        }

        break
      case 'guard': {
        const handler = node.catch as { name: string } | undefined

        if (handler) {
          names.add(handler.name)
        }

        break
      }
      default:
        break
    }
  })

  return names
}

// the names written inside any closure or nested task beneath a body. Such a write happens whenever the closure is
// called, which may be at any later call, so no fact about these names is ever safe to keep. They are VOLATILE.
export function volatileNames(body: Statement[]): Set<string> {
  const names = new Set<string>()

  visit(body, node => {
    if (node.form === 'closure' || node.form === 'function') {
      for (const name of writtenNames(node.body)) {
        names.add(name)
      }
    }
  })

  return names
}

// the variable names an expression reads, member roots included
export function readNames(expression: unknown): Set<string> {
  const names = new Set<string>()

  visit(expression, node => {
    if (node.form === 'variable') {
      names.add(node.name as string)
    }
  })

  return names
}

// does an expression read any of these names (or anything at all, when EVERYTHING is among them)
export function readsAny(expression: unknown, names: Set<string>): boolean {
  if (names.size === 0) {
    return false
  }

  if (names.has(EVERYTHING)) {
    return true
  }

  for (const name of readNames(expression)) {
    if (names.has(name)) {
      return true
    }
  }

  return false
}

// does an expression read state a call can change behind a name's back: a member of a record, or a call's result
export function readsState(expression: unknown): boolean {
  let found = false

  visit(expression, node => {
    if (node.form === 'member' || node.form === 'call' || node.form === 'await') {
      found = true
    }
  })

  return found
}

// The pure tasks of a program. A task is IMPURE when any of these holds, and the set closes over calls:
//
//   it is async, or has no body (a signature, or a separate-compilation stub, whose body nothing here can see)
//   it holds a `native` statement, or calls through a member (`call fs/read-file`, `call r/grow`), which is a dock
//     call or a method on a value, and either may touch the world or write through a record
//   it calls a name that is not a task of the program and is bound in its own scope (a parameter or a local holding
//     a function value), whose purity is unknown
//   it writes through a member of a name it did not bind itself (a parameter, `self`), which the caller can see
//   it reads or writes a mutable module-level binding
//   it calls an impure task
//
// A CLAIM (a signature-shaped `rule`) is pure by construction: it is a proposition, never run. A name that is neither
// a task of the program nor bound in scope is an intrinsic the compiler lowers (`add`, `is-equal`), which is pure.
// The answer for the last few PROGRAMS asked about, by identity. Was a module-level WeakMap per table, which a Term
// port cannot spell and a Rust build cannot hold (self-hosting-0022). A bounded memo keeps what the weak map was for,
// that a long-lived process does not keep every program it ever checked alive, and keeps the hit rate: the passes
// that ask alternate between at most a program and the checker's lowered copy of it (check/contract.ts), so four
// slots never thrash.
function recentPrograms<T>(size = 4): {
  get: (program: Program) => T | undefined
  set: (program: Program, value: T) => void
} {
  const slots: { program: Program; value: T }[] = []

  return {
    get: program => slots.find(slot => slot.program === program)?.value,
    set: (program, value) => {
      slots.unshift({ program, value })
      slots.length = Math.min(slots.length, size)
    },
  }
}

// the answer per program array: the kernel, both hold walks and the claim wall each ask, after the last pass that
// rewrites a body (async resolution runs before the kernel), so one answer serves them all
const PURE = recentPrograms<Purity>()

// purity's whole answer: the pure tasks, the tasks with an effect beyond writing through a parameter, and the parameter
// positions each task writes through. A separately compiled stub carries the last two (`stubFacts` `clean`,
// `stubWrites`), so a dependent decides a caller's purity at its call sites as the merged build does
export type Purity = { pure: Set<string>; impure: Set<string>; writes: Map<string, Set<number>> }

// A task's only statement, when its body is one statement: what the analyses that recognize a task by its SHAPE read
// (a list's push or pop, `max` and `min`, a one-line unfolding). A separately compiled stub has no body and carries
// that statement as `stubShape`
export function onlyStatement(fn: Fn): Statement | undefined {
  if (fn.stub) {
    return fn.stubShape
  }

  return fn.body.length === 1 ? fn.body[0] : undefined
}

export function pureFunctions(program: Program): Set<string> {
  return purity(program).pure
}

export function purity(program: Program): Purity {
  const known = PURE.get(program)

  if (known) {
    return known
  }

  const answer = computePure(program)
  PURE.set(program, answer)

  return answer
}

function computePure(program: Program): Purity {
  const functions = new Map<string, Fn>()
  const mutableGlobals = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'function') {
      functions.set(statement.name, statement)
    } else if (statement.form === 'let' && statement.mutable) {
      mutableGlobals.add(statement.name)
    }
  }

  const impure = new Set<string>()
  const calls = new Map<string, Set<string>>()
  // WRITES THROUGH A PARAMETER are kept apart from every other impurity: `list_push` writes through `self` and
  // touches nothing else, so a caller that hands it a list the caller MADE stays pure, and a caller that hands it its
  // own parameter writes through that parameter in turn. Without this, building a list of one's own (`make list`
  // then `push`) made a task impure, and every task that called it (found by optimize-0006, 2026-10-02)
  const writes = new Map<string, Set<number>>()
  // each call to a task of the program, with its arguments, to decide the above at the call site
  const sites = new Map<string, { callee: string; args: Expression[] }[]>()

  for (const [name, fn] of functions) {
    const called = new Set<string>()
    calls.set(name, called)
    const written = new Set<number>()
    writes.set(name, written)
    const at: { callee: string; args: Expression[] }[] = []
    sites.set(name, at)
    const paramIndex = (root: string | undefined): number =>
      root === undefined ? -1 : fn.params.findIndex(p => p.name === root)

    if (fn.claim) {
      continue
    }

    // a separately compiled task: what its own unit showed, with its body (`stubFacts`)
    if (fn.stub && fn.stubFacts) {
      if (fn.stubFacts.includes('clean')) {
        for (const i of fn.stubWrites ?? []) {
          written.add(i)
        }
      } else {
        impure.add(name)
      }

      continue
    }

    // a task that may never return (`note roam`) is not a function: two calls need not even both answer
    if (fn.async || fn.stub || fn.roam || fn.body.length === 0) {
      impure.add(name)
      continue
    }

    const own = writtenNames(fn.body)
    const params = new Set(fn.params.map(p => p.name))

    for (const param of fn.params) {
      own.add(param.name)
    }

    let dirty = false

    visit(fn.body, node => {
      if (dirty) {
        return
      }

      switch (node.form) {
        case 'native':
          dirty = true
          break
        case 'call': {
          const callee = node.callee as Expression | undefined

          // another dialect's node may also be called `call`, with no callee
          if (callee === undefined) {
            break
          }

          if (callee.form === 'variable') {
            if (functions.has(callee.name)) {
              called.add(callee.name)
              at.push({ callee: callee.name, args: (node.args as Expression[] | undefined) ?? [] })
            } else if (params.has(callee.name)) {
              // PARAMETRIC: calling a function the caller passed in is as pure as what the caller passed. The task
              // stays pure, and the use site answers for its argument (callsImpure reads a task passed as a value).
            } else if (stableLocal(fn.body, callee.name)) {
              // a local bound ONCE, never written again, to a value that is not read out of a record: whatever it
              // holds came from code this same walk checks (a call, a closure, a parameter)
            } else if (own.has(callee.name) || mutableGlobals.has(callee.name)) {
              dirty = true
            }
          } else if (!collectionCallIsPure(callee, fn)) {
            // a native list or map WRITE through a parameter (`self/push` in `list_push`) is a write through that
            // parameter, which the call site decides; anything else is impure
            const receiver = callee.form === 'member' ? (callee.target as Expression) : undefined
            const index =
              receiver?.form === 'variable' && COLLECTION_WRITES.has(callee.name) && isCollection(receiver.type)
                ? paramIndex(receiver.name)
                : -1

            if (index >= 0) {
              written.add(index)
            } else {
              dirty = true
            }
          }

          break
        }
        case 'assign': {
          const target = node.target as Expression
          const root = rootName(target)

          if (root === undefined || mutableGlobals.has(root)) {
            dirty = true
          } else if (target.form === 'member') {
            // a write through a record is visible to the caller unless this task made the record. A parameter, or a
            // name it never bound (`self`, a global), belongs to someone else.
            const parameter = paramIndex(root)

            if (parameter >= 0) {
              // a write through a parameter: the call site decides (see `writes`)
              written.add(parameter)
            } else if (!own.has(root)) {
              dirty = true
            }
          }

          break
        }
        case 'variable':
          if (mutableGlobals.has(node.name as string) && !own.has(node.name as string)) {
            dirty = true
          }

          // a task named as a VALUE (passed to another task) is a dependency like a call: passing an impure one
          // makes this task impure
          if (functions.has(node.name as string) && !own.has(node.name as string)) {
            called.add(node.name as string)
          }

          break
        case 'exit':
          dirty = true
          break
        default:
          break
      }
    })

    if (dirty) {
      impure.add(name)
    }
  }

  // close over calls. A task that calls an impure one is impure. A call to a task that writes through parameter i is
  // pure here when argument i is a list or map THIS task made (`madeHere`), a write through this task's own parameter
  // when argument i is that parameter, and impure otherwise. A task named as a value (in `called` but at no site) must
  // be pure outright, as before.
  let changed = true

  while (changed) {
    changed = false

    for (const [name, fn] of functions) {
      if (impure.has(name) || fn.claim) {
        continue
      }

      const mine = writes.get(name)!
      const before = mine.size
      let tainted = false

      for (const { callee, args } of sites.get(name)!) {
        if (impure.has(callee)) {
          tainted = true
          break
        }

        for (const i of writes.get(callee) ?? []) {
          const arg = args[i]
          const own = arg?.form === 'variable' ? fn.params.findIndex(p => p.name === arg.name) : -1

          if (own >= 0) {
            mine.add(own)
          } else if (!(arg?.form === 'variable' && madeHere(fn.body, arg.name))) {
            tainted = true
            break
          }
        }

        if (tainted) {
          break
        }
      }

      if (!tainted) {
        const atSite = new Set(sites.get(name)!.map(s => s.callee))

        for (const callee of calls.get(name)!) {
          if (!atSite.has(callee) && (impure.has(callee) || (writes.get(callee)?.size ?? 0) > 0)) {
            tainted = true
            break
          }
        }
      }

      if (tainted) {
        impure.add(name)
        changed = true
      } else if (mine.size !== before) {
        changed = true
      }
    }
  }

  const pure = new Set<string>()

  // pure: nothing impure, and no write through a parameter, which the caller would see
  for (const [name, fn] of functions) {
    if (!impure.has(name) && (fn.claim || (writes.get(name)?.size ?? 0) === 0)) {
      pure.add(name)
    }
  }

  return { pure, impure, writes }
}

// A method call on a NATIVE list or map, by the receiver's checked type, that touches nothing the caller can see.
// Before this, every method call made a task impure, so a task that only built a list of its own (`save out / make
// list` then `push`) was impure, and so was every task calling it: `count-each` could not have a twin
// (note/term/optimize/admission.md, found 2026-10-02).
//
//   a READ (get, has, keys, includes, ...) is pure on any list or map: it changes nothing
//   a WRITE (push, set, delete, ...) is pure only on a local this task bound to a list or map it MADE (`make list`,
//   `make hash`, a literal) and never bound to anything else, so no other name can be holding the same one
//
// Anything else (a method on a form, an unknown receiver, a write to a parameter or to a local that may be one) stays
// impure, as it was.
const COLLECTION_READS = new Set([
  'get', 'has', 'keys', 'values', 'entries', 'at', 'includes', 'indexOf', 'lastIndexOf', 'slice', 'concat', 'join',
  'map', 'filter', 'some', 'every', 'reduce', 'findIndex', 'find', 'toReversed', 'flat', 'forEach',
])
const COLLECTION_WRITES = new Set(['push', 'pop', 'set', 'delete', 'unshift', 'shift', 'splice', 'clear'])

function collectionCallIsPure(callee: Expression, fn: Fn): boolean {
  if (callee.form !== 'member') {
    return false
  }

  const receiver = callee.target as Expression

  if (!isCollection(receiver.type)) {
    return false
  }

  if (COLLECTION_READS.has(callee.name)) {
    return true
  }

  if (!COLLECTION_WRITES.has(callee.name) || receiver.form !== 'variable') {
    return false
  }

  const name = receiver.name

  return !fn.params.some(p => p.name === name) && madeHere(fn.body, name)
}

// a native list or map, by its checked type
function isCollection(type: Expression['type']): boolean {
  return (
    type?.kind === 'array' ||
    type?.kind === 'map' ||
    (type?.kind === 'named' && (type.name === 'list' || type.name === 'hash'))
  )
}

// is every binding and assignment of `name` in the body a fresh list or map (`make list`, `make hash`, a
// list or map literal)? Then the value it holds was made by this task and no other name shares it
function madeHere(body: Statement[], name: string): boolean {
  let bound = 0
  let fresh = true

  const isFresh = (value: unknown): boolean => {
    const v = value as { form?: string; name?: string; fields?: unknown[] } | undefined

    return (
      v?.form === 'array' ||
      v?.form === 'map' ||
      (v?.form === 'record' && (v.name === 'list' || v.name === 'hash') && (v.fields?.length ?? 0) === 0)
    )
  }

  visit(body, node => {
    if (node.form === 'let' && node.name === name) {
      bound++
      fresh = fresh && isFresh(node.init)
    } else if (node.form === 'assign') {
      const target = node.target as Expression

      if (target.form === 'variable' && target.name === name) {
        bound++
        fresh = fresh && isFresh(node.value)
      }
    }
  })

  return bound > 0 && fresh
}

// is a local name bound exactly once, never assigned, to a value that does not read a member: then the function it
// holds is one the enclosing task made or was handed, and its purity is decided by the same walk
function stableLocal(body: Statement[], name: string): boolean {
  let bindings = 0
  let writes = 0
  let fromState = false

  visit(body, node => {
    if (node.form === 'let' && node.name === name) {
      bindings++

      visit(node.init, inner => {
        if (inner.form === 'member') {
          fromState = true
        }
      })
    }

    if (
      node.form === 'assign' &&
      rootName(node.target as Expression) === name
    ) {
      writes++
    }
  })

  return bindings === 1 && writes === 0 && !fromState
}

// The STATE-FREE tasks: impure, but only in ways that cannot touch a Term value it was not handed. A task is
// state-free when it is not async (a task that waits lets other code run in between), reads and writes no mutable
// module-level binding, writes through no record it did not make, holds no inline native code, and every call it
// makes is to a pure task, to a state-free task with scalar arguments, or to a native module function with scalar
// arguments. Randomness and the clock are state-free; a task that keeps a cache in a global is not.
//
// The last case rests on one assumption about native code, which the trust ledger names: a native function handed
// only scalars does not reach a Term value, since it holds none and does not call back into Term.
const SCALARS = new Set(['number', 'float', 'boolean', 'string', 'unit', 'bytes'])

// the scalars no method can change in place, on any backend (`bytes` is a buffer, and can be)
export const IMMUTABLE = new Set(['number', 'float', 'boolean', 'string', 'unit'])

const STATE_FREE = recentPrograms<Set<string>>()
const LENGTH_KEEPING = recentPrograms<Set<string>>()
const RETURNS_FRESH = recentPrograms<Set<string>>()

export function stateFreeFunctions(program: Program): Set<string> {
  const known = STATE_FREE.get(program)

  if (known) {
    return known
  }

  const pure = pureFunctions(program)
  const returning = returnsFreshFunctions(program)
  const functions = new Map<string, Fn>()
  const globals = new Set<string>()
  const mutableGlobals = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'function') {
      functions.set(statement.name, statement)
    } else if (statement.form === 'let') {
      globals.add(statement.name)

      if (statement.mutable) {
        mutableGlobals.add(statement.name)
      }
    }
  }

  const candidates = new Set<string>()
  const needs = new Map<string, Set<string>>()

  for (const [name, fn] of functions) {
    // a separately compiled task is state-free when its own unit found it so, with nothing left for it to need
    if (fn.stub && fn.stubFacts?.includes('state-free') && !pure.has(name)) {
      candidates.add(name)
      needs.set(name, new Set())
      continue
    }

    if (pure.has(name) || fn.async || fn.stub || fn.claim || fn.body.length === 0) {
      continue
    }

    const own = localNames(fn)
    const params = new Set(fn.params.map(p => p.name))
    const fresh = freshNames(fn, returning)
    const depends = new Set<string>()
    let ok = true

    visit(fn.body, node => {
      if (!ok) {
        return
      }

      switch (node.form) {
        case 'native':
          ok = false
          break
        case 'variable':
          if (mutableGlobals.has(node.name as string) && !own.has(node.name as string)) {
            ok = false
          }

          break
        case 'assign': {
          const target = node.target as Expression
          const root = rootName(target)

          if (
            root === undefined ||
            mutableGlobals.has(root) ||
            (target.form === 'member' && (params.has(root) || !own.has(root)))
          ) {
            ok = false
          }

          break
        }
        case 'call': {
          const callee = node.callee as Expression | undefined
          const args = (node.args as Expression[] | undefined) ?? []
          // a scalar, or one element read out of a list of scalars (holds.ts scalarValue, the same rule)
          const scalars = args.every(
            a =>
              SCALARS.has(a.type?.kind ?? '') ||
              (a.form === 'member' &&
                a.index !== undefined &&
                a.target.type?.kind === 'array' &&
                SCALARS.has(a.target.type.element.kind)) ||
              (a.form === 'call' &&
                a.callee.form === 'member' &&
                (a.callee.name === 'get' || a.callee.name === 'at') &&
                a.callee.target.type?.kind === 'array' &&
                SCALARS.has(a.callee.target.type.element.kind)),
          )

          if (!callee) {
            break
          }

          if (callee.form === 'variable') {
            if (functions.has(callee.name)) {
              if (!pure.has(callee.name)) {
                if (scalars) {
                  depends.add(callee.name)
                } else {
                  ok = false
                }
              }
            } else if (own.has(callee.name)) {
              // a function value: whatever it closes over is unknown
              ok = false
            }
          } else if (callee.form === 'member') {
            const root = rootName(callee)
            // a method on a value this task made can change only that value; a function of a native module (a
            // name that is neither a local, a global nor a task) handed scalars reaches nothing. MADE means every
            // binding of the name is a fresh list or map: `save s, read state` binds the caller's own list, and a
            // push through `s` grows it
            const onOwn = root !== undefined && fresh.has(root)
            const onModule =
              root !== undefined &&
              !own.has(root) &&
              !globals.has(root) &&
              !functions.has(root)
            // a method on a value that cannot change (a number, a text), handed only scalars: `input/concat other`
            const onValue = IMMUTABLE.has(callee.target.type?.kind ?? '') && scalars

            if (!(onOwn || onValue || (onModule && scalars))) {
              ok = false
            }
          } else {
            ok = false
          }

          break
        }
        default:
          break
      }
    })

    if (ok) {
      candidates.add(name)
      needs.set(name, depends)
    }
  }

  // a state-free task may call only state-free tasks: drop any that call one that is not, until nothing changes
  let changed = true

  while (changed) {
    changed = false

    for (const name of [...candidates]) {
      for (const callee of needs.get(name) ?? []) {
        if (!candidates.has(callee)) {
          candidates.delete(name)
          changed = true
          break
        }
      }
    }
  }

  STATE_FREE.set(program, candidates)

  return candidates
}

// the names a task binds ONLY to a fresh list or map it makes itself (`make list`, `make hash`, a literal), never to
// a parameter, a field or a call's result, so a method on one can reach nothing the caller holds
export function freshNames(fn: Fn, returning: Set<string> = new Set()): Set<string> {
  const fresh = new Set<string>()
  const spoiled = new Set(fn.params.map(p => p.name))
  const made = (e: unknown): boolean => {
    const node = e as { form?: string; callee?: Expression } | undefined

    return (
      node?.form === 'array' ||
      node?.form === 'map' ||
      // a call to a task that hands back only a list it made (returnsFreshFunctions)
      (node?.form === 'call' &&
        node.callee?.form === 'variable' &&
        returning.has(node.callee.name))
    )
  }

  visit(fn.body, node => {
    if (node.form === 'let') {
      ;(made(node.init) ? fresh : spoiled).add(node.name as string)
    } else if (node.form === 'assign') {
      const target = node.target as Expression

      if (target.form === 'variable') {
        ;(made(node.value) ? fresh : spoiled).add(target.name)
      }
    } else if (node.form === 'for-each') {
      spoiled.add(node.item as string)
    } else if (node.form === 'closure' || node.form === 'function') {
      for (const p of (node.params as { name: string }[] | undefined) ?? []) {
        spoiled.add(p.name)
      }
    }
  })

  for (const name of spoiled) {
    fresh.delete(name)
  }

  return fresh
}

// the tasks that hand back only a list or map they made: every `send back` is a literal, a fresh name (freshNames),
// or a call to another such task. Each call makes a new value, so a name bound to one is fresh in its caller. A
// greatest fixed point, so two such tasks may call each other.
export function returnsFreshFunctions(program: Program): Set<string> {
  const known = RETURNS_FRESH.get(program)

  if (known) {
    return known
  }

  const functions = new Map<string, Fn>()
  // a separately compiled task its own unit found returns only what it made: a candidate with nothing to re-check
  const settled = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'function' && statement.stub && statement.stubFacts?.includes('returns-fresh')) {
      settled.add(statement.name)
    } else if (
      statement.form === 'function' &&
      !statement.async &&
      !statement.stub &&
      statement.body.length > 0
    ) {
      functions.set(statement.name, statement)
    }
  }

  const candidates = new Set([...functions.keys(), ...settled])
  let changed = true

  while (changed) {
    changed = false

    for (const name of [...candidates]) {
      if (settled.has(name)) {
        continue
      }

      const fn = functions.get(name)!
      const fresh = freshNames(fn, candidates)
      let ok = true
      let returns = 0

      visit(fn.body, node => {
        if (!ok || node.form !== 'return') {
          return
        }

        returns++
        const value = node.value as Expression | undefined

        if (
          !value ||
          !(
            value.form === 'array' ||
            value.form === 'map' ||
            (value.form === 'variable' && fresh.has(value.name)) ||
            (value.form === 'call' &&
              value.callee.form === 'variable' &&
              candidates.has(value.callee.name))
          )
        ) {
          ok = false
        }
      })

      if (!ok || returns === 0) {
        candidates.delete(name)
        changed = true
      }
    }
  }

  RETURNS_FRESH.set(program, candidates)

  return candidates
}

// the tasks that change NO list's length, anywhere: every change they make is a `set` on a list, which owes its index
// as a tier-0 obligation (check/contract.ts) and so lands inside the list, or a method on a list or map they made,
// or a call to a pure, state-free or length-keeping task. A caller keeps every length fact across a call to one,
// which is what lets `aes-add-round-key`, folding a key into a state in place, leave the state's length known.
// A greatest fixed point: recursion between such tasks keeps lengths too, since no step of either changes one.
export function lengthKeepingFunctions(program: Program): Set<string> {
  const known = LENGTH_KEEPING.get(program)

  if (known) {
    return known
  }

  const pure = pureFunctions(program)
  const stateFree = stateFreeFunctions(program)
  const returning = returnsFreshFunctions(program)
  const functions = new Map<string, Fn>()

  for (const statement of program) {
    if (statement.form === 'function') {
      functions.set(statement.name, statement)
    }
  }

  const candidates = new Set<string>()
  const needs = new Map<string, Set<string>>()

  for (const [name, fn] of functions) {
    if (pure.has(name) || stateFree.has(name) || (fn.stub && fn.stubFacts?.includes('length-keeping'))) {
      candidates.add(name)
      needs.set(name, new Set())
      continue
    }

    if (fn.async || fn.stub || fn.claim || fn.body.length === 0) {
      continue
    }

    const own = localNames(fn)
    const fresh = freshNames(fn, returning)
    const depends = new Set<string>()
    let ok = true

    visit(fn.body, node => {
      if (!ok) {
        return
      }

      switch (node.form) {
        case 'native':
          ok = false
          break
        case 'assign': {
          // a write through a member may land past the end of a list
          if ((node.target as Expression).form === 'member') {
            ok = false
          }

          break
        }
        case 'call': {
          const callee = node.callee as Expression | undefined
          const args = (node.args as Expression[] | undefined) ?? []

          if (!callee) {
            break
          }

          if (callee.form === 'variable') {
            if (functions.has(callee.name)) {
              if (!pure.has(callee.name) && !stateFree.has(callee.name)) {
                depends.add(callee.name)
              }
            } else if (own.has(callee.name)) {
              ok = false
            }
          } else if (callee.form === 'member') {
            const root = rootName(callee)
            const list = callee.target.type
            const onList = list?.kind === 'array' && !callee.index
            // a `set` changes no length anywhere; a caller forgets only what it knew THROUGH a list position
            // (holds.ts dropElementPaths)
            const keeps =
              onList &&
              ((callee.name === 'set' && args.length === 2) ||
                ((callee.name === 'get' || callee.name === 'at') && args.length === 1) ||
                READ_ONLY_LIST_METHODS.has(callee.name))

            // a method on a value that cannot change, handed only values that cannot change
            const onValue =
              IMMUTABLE.has(list?.kind ?? '') &&
              args.every(a => IMMUTABLE.has(a.type?.kind ?? ''))

            if (!(keeps || onValue || (root !== undefined && fresh.has(root)))) {
              ok = false
            }
          } else {
            ok = false
          }

          break
        }
        default:
          break
      }
    })

    if (ok) {
      candidates.add(name)
      needs.set(name, depends)
    }
  }

  let changed = true

  while (changed) {
    changed = false

    for (const name of [...candidates]) {
      for (const callee of needs.get(name) ?? []) {
        if (!candidates.has(callee)) {
          candidates.delete(name)
          changed = true
          break
        }
      }
    }
  }

  LENGTH_KEEPING.set(program, candidates)

  return candidates
}

// the list methods that only READ the list they are called on (deck/base/code/list.tree): calling one changes no
// length. Named, and checked against the receiver's type, so a method of the same name on anything but a list
// still counts as reaching it. None takes a function, which could change anything.
export const READ_ONLY_LIST_METHODS = new Set([
  'get',
  'size',
  'is-empty',
  'slice',
  'copy',
  'index-of',
  'includes',
  'join',
])

// does an expression call anything whose result two calls might not agree on: an impure task of the program, a
// function value bound in scope, or a member (a dock alias, a method on a value)
export function callsImpure(
  expression: unknown,
  pure: Set<string>,
  functions: Set<string>,
  local: Set<string> = new Set(),
): boolean {
  let found = false

  visit(expression, node => {
    if (found) {
      return
    }

    // an impure task named as a value, passed to a task that will call it, is an impure call made one step later. A
    // local binding of the same name shadows the task: it is a value of its own
    if (
      node.form === 'variable' &&
      functions.has(node.name as string) &&
      !pure.has(node.name as string) &&
      !local.has(node.name as string)
    ) {
      found = true

      return
    }

    if (node.form !== 'call' || node.callee === undefined) {
      return
    }

    const callee = node.callee as Expression

    if (callee.form !== 'variable') {
      found = true
    } else if (functions.has(callee.name)) {
      found = !pure.has(callee.name)
    } else if (local.has(callee.name)) {
      found = true
    }
  })

  return found
}

// the names a task binds itself: its parameters and everything its body writes or binds
export function localNames(fn: Fn): Set<string> {
  const names = writtenNames(fn.body)

  for (const param of fn.params) {
    names.add(param.name)
  }

  return names
}

// the names of every task in a program
export function functionNames(program: Program): Set<string> {
  const names = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'function') {
      names.add(statement.name)
    }
  }

  return names
}
