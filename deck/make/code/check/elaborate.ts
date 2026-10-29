// Elaboration: the bridge that makes the sound dependent kernel (check/judging.tree) the single type-checking
// authority. The surface pass (resolve + infer) is the inference front-end; here the annotated surface AST becomes
// explicit kernel terms and the KERNEL verifies them (note/project/term/archive/computation/plans/12-type-systems.md,
// step 5).
//
// THE FACE (item term-self-host-001-0070, decision 055). The run is Term, check/elaborating-report.tree, over the ten
// parts under check/ (elaborating-data, -rewrite, -cases, -terms, -proof, -commands, -theorems, -induction, -holds,
// -main). This face holds the TypeScript modules no item has made Term yet, handed in as one host (check/totality.ts,
// check/effects.ts, check/unfold.ts, check/induct.ts, check/holds.ts's `isLinearGoal` and `orderFollows`), the
// diagnostic builder, the `TERM_KERNEL_TRACE` line, and the error classes: the run goes through judge.ts's `kernel`,
// and a `decline:` failure out of it becomes `Decline`. Before: tmp/retired/make/check/elaborate-face.ts.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import * as report from '@term/make/code/check/elaborating-report'
import type { Expression, Program } from '@term/make/code/compile/node'
import { judgeState, kernel } from '@term/make/code/check/judge'
import { terminatingFunctions } from '@term/make/code/check/totality'
import { effectRows } from '@term/make/code/check/effects'
import { isLinearGoal, orderFollows } from '@term/make/code/check/holds'
import { checkFold, checkFoldOrder } from '@term/make/code/check/induct'
import { unfoldDefinitions } from '@term/make/code/check/unfold'

// thrown to abandon checking a construct the effect layer cannot represent yet (distinct from a real type error,
// which surfaces as the kernel's TypeError). A declined function is left to the surface checker and counted, with
// the reason, in the report's `declined`.
class Decline extends Error {
  constructor(
    readonly reason = 'an expression the kernel cannot represent',
  ) {
    super(reason)
  }
}

// a Term part's decline (a `failure` whose note is `decline:` and the reason, check/judging.tree `decline`) as the
// original's `Decline`, and any other raise as it came
function asDecline(error: unknown): unknown {
  const raised = error as { form?: unknown; note?: unknown } | undefined

  if (
    raised?.form === 'failure' &&
    typeof raised.note === 'string' &&
    raised.note.startsWith('decline:')
  ) {
    return new Decline(raised.note.slice('decline:'.length))
  }

  return error
}

// the elaboration result: kernel diagnostics, plus which functions the kernel actually verified (versus declined
// as outside the covered fragment). The `verified` set is what proves the kernel did the work, not a rubber stamp.
export type ElaborationReport = {
  diagnostics: Diagnostic[]
  verified: string[]
  // the tasks whose WHOLE BODY elaborated to one kernel term checked against the declared type. This is the only
  // kind of verification that is a proof: a body the command checker accepts is type-safe statement by statement,
  // but nothing there checks that every path returns a value, so a body with no return at all passed it. A claim's
  // fill must be in this set (check/claim.ts).
  proven: string[]
  // every task the kernel did not verify, with the reason, so "the kernel checked it" and "the kernel never looked"
  // can be told apart and counted (proof-by-default-0005)
  declined: { name: string; reason: string }[]
  // every task checked statement by statement (verified, not proven), with why the pure lowering did not make its body
  // one term: the first construct it met that it cannot lower (proof-by-default-0009). No such task goes uncounted
  statementwise: { name: string; reason: string }[]
  discharged: Span[]
}

export function elaborate(
  program: Program,
  file: string,
): Diagnostic[] {
  return elaborateReport(program, file).diagnostics
}

// what the run asks of TypeScript, for one file
function hostFor(
  file: string,
): Parameters<typeof report.elaborateReport>[3] {
  return {
    // best-effort: a failure means no function is treated as transparent, a sound fallback, never a compiler crash
    terminatingFunctions: (program: unknown) => {
      try {
        return [...terminatingFunctions(program as Program)]
      } catch {
        return []
      }
    },
    effectRows: (program: unknown) => {
      try {
        return effectRows(program as Program)
      } catch {
        return new Map()
      }
    },
    unfoldDefinitions: (expression: unknown, program: unknown) =>
      unfoldDefinitions(expression as Expression, program as Program),
    checkFold: (program: unknown, goal: unknown, inductVar: string) =>
      checkFold(program as Program, goal as Expression, inductVar),
    checkFoldOrder: (
      program: unknown,
      goal: unknown,
      inductVar: string,
      guards: unknown,
    ) =>
      checkFoldOrder(
        program as Program,
        goal as Expression,
        inductVar,
        guards as Expression[],
      ),
    isLinearGoal: (goal: unknown) => isLinearGoal(goal as Expression),
    orderFollows: (goal: unknown, facts: unknown) =>
      orderFollows(goal as Expression, facts as Expression[]),
    diagnose: (
      name: string,
      span: unknown,
      message: string,
      hint: string,
    ) =>
      diagnose(name as never, {
        file,
        span: span as Span,
        message,
        ...(hint ? { hint } : {}),
      }),
    trace: (name: string, message: string) => {
      // TERM_KERNEL_TRACE=1 prints where the kernel failed on a task, which the decline reason alone cannot say
      if (
        typeof process !== 'undefined' &&
        process.env?.TERM_KERNEL_TRACE
      ) {
        console.error(`kernel trace for ${name}:`, message)
      }

      return true
    },
  } as never
}

export function elaborateReport(
  written: Program,
  file: string,
): ElaborationReport {
  try {
    return kernel(() =>
      report.elaborateReport(
        judgeState(),
        written as never,
        file,
        hostFor(file),
      ),
    ) as unknown as ElaborationReport
  } catch (error) {
    throw asDecline(error)
  }
}
