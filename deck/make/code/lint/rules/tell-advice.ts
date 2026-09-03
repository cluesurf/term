// The three `tell` conditions of note/term/hive/06-tell.md that are advice, not errors (the four errors are in
// check/tell.ts). Each is about the SEVENTEEN: the generic exception an app's exception descends from decides what a
// caller should be told, so the rules read the root of every exception's chain.
//
//   L037 tell-missing    a reachable exception under a fix-the-input root (`absence`, `excess`, ...) with no tell.
//                        Leaving it private is allowed, and is probably an oversight.
//   L038 tell-of-failure a tell for an exception under `failure`, `overload`, `outage` or `timeout`. A server failure
//                        is never the caller's business.
//   L039 tell-reveals    a tell on `anonymity` or `denial` that carries a `link`. Saying which resource confirms it
//                        exists.
//
// They fire only in a program that makes decisions: one that declares a `tell` or a `dock` route. A library module
// raises exceptions it never tells, and that is not advice it needs. The reachable set is the raise set of the
// program's own tasks and routes (check/effects.ts), computed once per program.

import type { Program, Statement } from '@term/make/code/compile/node'
import type { LintContext, LintNode, Rule } from '@term/make/code/lint/rule'
import { raiseSets } from '@term/make/code/check/effects'
import { EXCEPTION_FORM } from '@term/make/code/check/extend'
import { GENERIC_EXCEPTIONS } from '@term/make/code/compile/roll'

type RecordType = Extract<Statement, { form: 'record-type' }>
type Tell = Extract<Statement, { form: 'tell' }>

// the roots a caller can act on, the roots that are the server's own business, and the roots a link would betray
const FIX_THE_INPUT = new Set(['defect', 'omission', 'excess', 'shortage', 'mismatch', 'exclusion', 'absence', 'conflict', 'refusal'])
const SERVER_FAILURE = new Set(['failure', 'overload', 'outage', 'timeout'])
const CONFIDENTIAL = new Set(['anonymity', 'denial'])

type Facts = {
  decides: boolean
  // exception name -> its generic root, for every exception form in the program
  rootOf: Map<string, string>
  // the exceptions the program's own tasks and routes can raise
  reachable: Set<string>
  // bare exception name -> the tell that names it
  told: Map<string, Tell>
}

// The facts below are computed at most once per lint call, through the shared `context.memo`.
//
// This was a `WeakMap<Program, Facts>`: keyed by the program OBJECT, so the cache could not pin a program in memory.
// Term has no weak reference and no identity-keyed map, and needs neither (self-hosting-0002). The memo lives on the
// lint call, which is the exact lifetime wanted, so nothing is keyed and nothing can collide.

// the base of a record as written: `like exception` / `like excess`, before or after extendForms resolved the chain
function baseOf(record: RecordType): string | undefined {
  if (record.chain?.length) {
    return record.chain[record.chain.length - 1]
  }

  const base = record.extend?.base

  return base?.kind === 'named' ? base.name : undefined
}

function facts(context: LintContext): Facts {
  const known = context.memo.tell as Facts | undefined

  if (known) {
    return known
  }

  const program = context.program

  const records = new Map<string, RecordType>()
  const tells: Tell[] = []
  let decides = false

  for (const s of program) {
    if (s.form === 'record-type') {
      records.set(s.name, s)
    } else if (s.form === 'tell') {
      tells.push(s)
      decides = true
    } else if (s.form === 'dock') {
      decides = true
    }
  }

  // an exception is a record whose base chain reaches `exception`; its root is the first of the seventeen on the way
  // up (itself, when it is one of them)
  const rootOf = new Map<string, string>()

  const climb = (name: string, seen: Set<string>): string | undefined => {
    if (seen.has(name)) {
      return undefined
    }

    seen.add(name)

    if (name === EXCEPTION_FORM) {
      return EXCEPTION_FORM
    }

    const record = records.get(name)
    const base = record ? baseOf(record) : undefined
    const above = base ? climb(base, seen) : undefined

    if (above === undefined) {
      return undefined
    }

    return GENERIC_EXCEPTIONS.has(name) ? name : above
  }

  for (const name of records.keys()) {
    const root = climb(name, new Set())

    if (root !== undefined && name !== EXCEPTION_FORM) {
      rootOf.set(name, root)
    }
  }

  const sets = raiseSets(program, new Set(rootOf.keys()))
  const reachable = new Set<string>()

  for (const s of program) {
    if (s.form === 'function') {
      for (const name of sets.raises.get(s.name) ?? []) {
        reachable.add(name)
      }
    }

    if (s.form === 'dock') {
      const walk = (route: (typeof s)['route']): void => {
        for (const call of [...route.calls, ...route.methods.flatMap(m => m.calls)]) {
          for (const name of sets.raises.get(call.name) ?? []) {
            reachable.add(name)
          }
        }

        route.children.forEach(walk)
      }

      walk(s.route)
    }
  }

  const told = new Map<string, Tell>()

  for (const tell of tells) {
    told.set(tell.name.slice(tell.name.lastIndexOf('/') + 1), tell)
  }

  const out: Facts = { decides, rootOf, reachable, told }

  context.memo.tell = out

  return out
}

// the program a node belongs to is what the driver hands every rule
function programOf(context: LintContext): Program | undefined {
  return context.program
}

export const tellMissing: Rule = {
  name: 'tell-missing',
  code: 'L037',
  severity: 'warning',
  docs: 'a reachable exception a caller could act on (under defect, omission, excess, shortage, mismatch, exclusion, absence, conflict or refusal) has no tell, so a customer sees only which of the seventeen it is',
  fixable: false,
  check(target: LintNode, context: LintContext): void {
    if (target.kind !== 'statement' || target.node.form !== 'record-type') {
      return
    }

    const program = programOf(context)

    if (!program) {
      return
    }

    const { decides, rootOf, reachable, told } = facts(context)
    const record = target.node
    const root = rootOf.get(record.name)

    if (!decides || root === undefined || !FIX_THE_INPUT.has(root) || !reachable.has(record.name) || told.has(record.name)) {
      return
    }

    context.report({
      message: `"${record.name}" is ${root === 'absence' || root === 'exclusion' || root === 'excess' || root === 'omission' ? 'an' : 'a'} ${root} a caller can act on, and nothing tells it; leaving it private is allowed, and is probably an oversight`,
      span: record.span,
    })
  },
}

export const tellOfFailure: Rule = {
  name: 'tell-of-failure',
  code: 'L038',
  severity: 'warning',
  docs: 'a tell for an exception under failure, overload, outage or timeout: a server failure is never the caller\'s business',
  fixable: false,
  check(target: LintNode, context: LintContext): void {
    if (target.kind !== 'statement' || target.node.form !== 'tell') {
      return
    }

    const program = programOf(context)

    if (!program) {
      return
    }

    const { rootOf } = facts(context)
    const tell = target.node
    const bare = tell.name.slice(tell.name.lastIndexOf('/') + 1)
    const root = rootOf.get(bare)

    if (root === undefined || !SERVER_FAILURE.has(root)) {
      return
    }

    context.report({
      message: `"${tell.name}" is ${root === 'outage' || root === 'overload' ? 'an' : 'a'} ${root}: a server failure is never the caller's business, so this tell says more than it should`,
      span: tell.span,
    })
  },
}

export const tellReveals: Rule = {
  name: 'tell-reveals',
  code: 'L039',
  severity: 'warning',
  docs: 'a tell on anonymity or denial that carries a link: saying which resource confirms it exists',
  fixable: false,
  check(target: LintNode, context: LintContext): void {
    if (target.kind !== 'statement' || target.node.form !== 'tell') {
      return
    }

    const program = programOf(context)

    if (!program) {
      return
    }

    const { rootOf } = facts(context)
    const tell = target.node
    const bare = tell.name.slice(tell.name.lastIndexOf('/') + 1)
    const root = rootOf.get(bare)

    if (root === undefined || !CONFIDENTIAL.has(root) || tell.links.length === 0) {
      return
    }

    context.report({
      message: `"${tell.name}" is ${root === 'anonymity' ? 'an' : 'a'} ${root} and its tell carries ${tell.links.map(l => `"${l}"`).join(', ')}: saying which resource confirms it exists`,
      span: tell.span,
    })
  },
}
