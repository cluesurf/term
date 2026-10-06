// The selection pass (note/term/optimize/pipeline.md, optimize-0008): put a CHOSEN implementation of a task behind
// every call to it, for one target. The pass is Term, ir/selection.tree (self-hosting, 2026-10-06), and its header says
// what it writes and what it refuses. This face keeps the TypeScript shape of a choice, which a pin (`bake.json`) and
// the caller of compile() write, reads it into the port's `twin-choice`, and writes back the program it was handed.

import type { Program, Twin } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import {
  applyTwins as applyTwinsIn,
  chosenTask as chosenTaskIn,
  exposeTwins as exposeTwinsIn,
  guardTask as guardTaskIn,
  twinTask as twinTaskIn,
} from '@term/make/code/ir/selection'
import type { TwinChoice as Choice } from '@term/make/code/ir/selection'

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

export const twinTask = (task: string, label: string): string => twinTaskIn(task, label)
export const chosenTask = (task: string): string => chosenTaskIn(task)
export const guardTask = (task: string, label: string): string => guardTaskIn(task, label)

function choiceOf(choice: TwinChoice): Choice {
  if (choice === 'reference') {
    return { form: 'reference' }
  }

  if ('use' in choice) {
    return { form: 'use', label: choice.use }
  }

  return { form: 'size', of: choice.of, below: choice.below, small: choiceOf(choice.then), large: choiceOf(choice.else) }
}

// the program the port answers, written into the one the caller handed (on TypeScript it is the same list)
function writeBack(program: Program, answered: Program): void {
  if (answered !== program) {
    program.splice(0, program.length, ...answered)
  }
}

// every twin of the program as a plain task beside its reference, with its `hook test`s as one boolean task, and no
// call redirected: what admission (deck/test/code/twin-diff.ts) calls. Returns the twins it exposed.
export function exposeTwins(program: Program, twins: Twin[]): Twin[] {
  const answer = exposeTwinsIn(program, twins)
  writeBack(program, answer.program)

  return answer.twins
}

export function applyTwins(
  program: Program,
  twins: Twin[],
  choices: TwinChoices,
  env: string | undefined,
  file: string,
): Diagnostic[] {
  const answer = applyTwinsIn(
    program,
    twins,
    Object.entries(choices).map(([task, choice]) => ({ task, choice: choiceOf(choice) })),
    env ?? '',
    file,
  )
  writeBack(program, answer.program)

  return answer.diagnostics
}
