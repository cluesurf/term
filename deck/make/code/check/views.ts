// A component's lowered code is type-checked.
//
// Views are lowered to plain functions over the render runtime AFTER the checker (compile/view-lower.ts runs last, after
// simplify), so the code a component actually runs was never checked: `read read-signal(count)` handed a `number` to
// `make-dynamic-text`, which takes a task to `text`, and the build went on (guides: applications/web/components,
// 2026-10-03). The checker reads a `view` as markup and cannot see that call.
//
// So a program with a component of this file is checked a second time with its views lowered: a copy taken before
// the main check (which annotates the program it reads), lowered, and put through the surface pass and the kernel, as
// the main program is. The kernel is needed: the surface pass is gradual about a closure's result and lets that call
// through, and the kernel refuses it in ordinary code as well. An error the copy raises inside a component of this
// file refuses the build. The main check has already passed by then, so anything else the copy says is about the
// lowering itself and is left to the lowering's own tests.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { check } from '@term/make/code/check/infer'
import { elaborateReport } from '@term/make/code/check/elaborate'
import { lowerZones } from '@term/make/code/compile/view-lower'

// the copy to check later, or nothing when the file defines no component
export function copyForViews(program: Program, file: string): Program | undefined {
  return program.some(s => s.form === 'view' && s.span.file === file) ? structuredClone(program) : undefined
}

export function checkLoweredViews(copy: Program, file: string, merged?: boolean): Diagnostic[] {
  const views = copy.filter(s => s.form === 'view' && s.span.file === file).map(s => s.span)
  const lowered = lowerZones(copy)

  // inside a component of this file, by the source position the lowering kept: the user's own expressions keep theirs,
  // and what the lowering built carries the component's
  const inside = (d: Diagnostic): boolean =>
    views.some(
      span =>
        d.span.file === file &&
        (d.span.start.line > span.start.line ||
          (d.span.start.line === span.start.line && d.span.start.column >= span.start.column)) &&
        (d.span.start.line < span.end.line ||
          (d.span.start.line === span.end.line && d.span.start.column <= span.end.column)),
    )

  const surface = check(lowered, file, merged).filter(d => d.severity !== 'warning' && inside(d))

  if (surface.length) {
    return surface
  }

  return elaborateReport(lowered, file).diagnostics.filter(inside)
}
