// Per-module ESM emit (Tier 2, separate compilation). Where `emitTypeScript` emits the whole merged program as one
// blob, `emitModules` emits one ESM file per source module, with `import` statements reconnecting cross-module
// references. This is what the dev server serves lazily over native ESM, and the foundation for fine-grained HMR.
//
// The merged program carries no module boundaries except each statement's `span.file`. So the import graph is
// reconstructed: group statements by that file, build a name -> defining-file map (last definition wins, matching
// `emitTypeScript`'s dedup, which resolves the abstract/impl native-delegation case to the impl), then for each module
// add an import for every cross-module function and type it references. A name is always imported from its TRUE
// definer, so `bear` re-exports need no special handling (ESM resolves transitively).
// See note/seed/plan/compilation-performance.md (Tier 2, step 1).
//
// The plan of each module (its imports, the binds it borrows, whether it is a component module, the files it depends
// on) is compile/module-emit.tree (self-hosting, 2026-10-06). This face emits each module's body with `emitTypeScript`
// and joins the pieces, and hands the port the URL of a file, the emitter's spellings, and whether a statement carries
// a `stubExport`.

import type { Program, Statement } from '@term/make/code/compile/node'
import {
  emitTypeScript,
  toCamel,
  toPascal,
} from '@term/make/code/compile/typescript'
import { planModules } from '@term/make/code/compile/module-emit'

// one emitted module: its JS (well, TS) code, the source files it imports (the dependency edges the dev server's
// module graph + HMR need), and whether it is a `zone` module (a self-accepting HMR boundary)
export interface ModuleEmit {
  code: string
  imports: string[]
  isZone: boolean
}

// the hot handle, declared once per zone module before the component functions (which reference it). `__seedHot` is a
// global the dev client installs; outside the dev server it is absent, so `hot` is undefined and the wiring is inert.
function hotPrelude(): string {
  return `const hot = typeof __seedHot !== "undefined" ? __seedHot(import.meta.url) : undefined`
}

// the hot boundary, registered once per zone module after the component functions. On a change the dev client calls
// `dispose` (snapshot each instance's signals, tear down its effects, remove its nodes, remember its host) then
// `accept` with the fresh module (re-mount each remembered host from the new code, restoring the snapshot).
function hotEpilogue(): string {
  return `if (hot) {
  hot.dispose((data) => {
    data.signals = {}
    data.remount = []
    for (const inst of (data.instances || [])) {
      const snapshot = {}
      for (const key in inst.signals) snapshot[key] = readSignal(inst.signals[key])
      data.signals[inst.zone] = snapshot
      disposeScope(inst.scope)
      for (const node of inst.nodes) remove(node)
      data.remount.push({ zone: inst.zone, host: inst.host })
    }
    data.instances = []
  })
  hot.accept((mod) => {
    for (const entry of (hot.data.remount || [])) mod[entry.zone](entry.host)
    hot.data.remount = []
  })
}`
}

// emit one ESM module per source file. `urlForFile` maps a source file to the URL the browser imports it by. Returns,
// per source file, the emitted code plus its dependency edges and zone flag (for the dev server's graph + HMR).
export function emitModules(
  program: Program,
  urlForFile: (file: string) => string,
  // the files to emit, when not all of them. Every file's statements are still the context each emit reads
  only?: Set<string>,
): Map<string, ModuleEmit> {
  const plans = planModules(
    program as never,
    urlForFile,
    toCamel,
    toPascal,
    (statement: Statement) => 'stubExport' in statement && statement.stubExport !== undefined,
    only === undefined ? { form: 'none' } : { form: 'some', value: [...only] },
  )
  const variants = new Set(plans.variants)
  const out = new Map<string, ModuleEmit>()

  for (const plan of plans.plans) {
    // zone modules emit HMR-aware component bodies (signals seeded from the kept snapshot, instances registered)
    // the whole program as context: a `case` here on a form another module defines needs its fields (`context`)
    const body = emitTypeScript([...plan.borrowed, ...plan.statements] as Program, {
      hmr: plan.isZone,
      variants,
      exportConstants: true,
      context: program,
    })

    const pieces = [
      plan.lines.join('\n'),
      plan.isZone ? hotPrelude() : '',
      body,
      plan.isZone ? hotEpilogue() : '',
    ].filter(Boolean)

    out.set(plan.file, {
      code: pieces.join('\n\n'),
      imports: plan.imports,
      isZone: plan.isZone,
    })
  }

  return out
}
