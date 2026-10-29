// A MISSING `wait` ON A HOST CALL THAT ANSWERS A PROMISE (term/compiler decision 004, guides: language/async gap 151,
// architecture/language/async gap 56), and a field read off the promise an unmarked bind answers (decision 053 of
// note/project/term/self-host/change/001-finish-self-host, traps T-0334).
//
// The check is Term, check/missing-wait-refusals.tree, and its header says what it refuses and why (item
// term-self-host-change-001-finish-self-host-0003). compile/program-types.tree docks this face, which keeps the
// TypeScript names and the optional file its callers know.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import * as port from '@term/make/code/check/missing-wait-refusals'

// a host module whose every function answers a promise, known by its path
export function answersPromises(module: string): boolean {
  return port.answersPromises(module)
}

// whether a bind's host text answers a promise, by its outermost shape
export function promiseText(text: string): boolean {
  return port.promiseText(text)
}

// every call into a promise module left unwaited, then every field read off an unmarked bind's promise
export function checkMissingWaits(
  program: Program,
  file?: string,
): Diagnostic[] {
  return port.checkMissingWaits(
    program as never,
    file ?? '',
  ) as Diagnostic[]
}

// the field reads off an unmarked bind's promise alone
export function checkUnwaitedBindReads(
  program: Program,
  file?: string,
): Diagnostic[] {
  return port.checkUnwaitedBindReads(
    program as never,
    file ?? '',
  ) as Diagnostic[]
}
