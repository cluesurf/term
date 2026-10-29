// A component's lowered code is type-checked.
//
// Views are lowered to plain functions over the render runtime AFTER the checker, so the code a component actually runs
// was never checked: a program with a component of this file is checked a second time with its views lowered, through
// the surface pass and the kernel, and an error inside a component of this file refuses the build. The check is Term,
// check/views-lowered.tree, and its header says why (item term-self-host-001-0103). compile/program-types.tree docks
// this face, which keeps the TypeScript names its callers know.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { overloadBound } from '@term/make/code/check/overload'
import * as port from '@term/make/code/check/views-lowered'

// the copy to check later, or nothing when the file defines no component
export function copyForViews(
  program: Program,
  file: string,
): Program | undefined {
  const copy = port.copyForViews(program as never, file) as {
    form: string
    value?: unknown
  }

  return copy.form === 'some' ? (copy.value as Program) : undefined
}

// the copy's views lowered and checked: the errors inside a component of this file, the surface pass's first. The
// runtime names the lowering writes are what the last binding left (decision 069), read now
export function checkLoweredViews(
  copy: Program,
  file: string,
  merged?: boolean,
): Diagnostic[] {
  return port.checkLoweredViews(
    copy as never,
    file,
    merged === true,
    overloadBound.runtime,
  ) as unknown as Diagnostic[]
}
