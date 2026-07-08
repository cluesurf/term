// Per-module ESM emit (Tier 2, separate compilation). Where `emitTypeScript` emits the whole merged program as one
// blob, `emitModules` emits one ESM file per source module, with `import` statements reconnecting cross-module
// references. This is what the dev server serves lazily over native ESM, and the foundation for fine-grained HMR.
//
// The merged program carries no module boundaries except `origin` (statement -> source file). So the import graph is
// reconstructed here: group statements by origin, build a name -> defining-file map (last definition wins, matching
// `emitTypeScript`'s dedup, which resolves the abstract/impl native-delegation case to the impl), then for each module
// add an import for every cross-module function and type it references. A name is always imported from its TRUE
// definer, so `bear` re-exports need no special handling (ESM resolves transitively).
// See note/seed/plan/compilation-performance.md (Tier 2, step 1).

import type {
  Program,
  Statement,
  Expression,
  Type,
} from '@cluesurf/make/code/compile/node'
import {
  emitTypeScript,
  toCamel,
  toPascal,
} from '@cluesurf/make/code/compile/typescript'

const ENTRY = '<entry>'

// collect the named-type references inside a type (for `import type`)
function walkType(type: Type | undefined, types: Set<string>): void {
  if (!type) {
    return
  }

  switch (type.kind) {
    case 'named':
      types.add(type.name)
      type.args?.forEach(a => walkType(a, types))
      break
    case 'array':
      walkType(type.element, types)
      break
    case 'map':
      walkType(type.key, types)
      walkType(type.value, types)
      break
    case 'function':
      type.params.forEach(p => walkType(p, types))
      walkType(type.result, types)
      break
    default:
      break
  }
}

// collect cross-module references in an expression: function-bound names (values) and named types in annotations
function walkExpr(
  expr: Expression,
  values: Set<string>,
  types: Set<string>,
): void {
  switch (expr.form) {
    case 'variable':
      // only a reference to a top-level function needs a value import (locals / params / builtins do not)
      if (expr.binding?.kind === 'function') {
        values.add(expr.name)
      }

      break
    case 'call':
      walkExpr(expr.callee, values, types)
      expr.args.forEach(a => walkExpr(a, values, types))
      break
    case 'binary':
      walkExpr(expr.left, values, types)
      walkExpr(expr.right, values, types)
      break
    case 'unary':
      walkExpr(expr.operand, values, types)
      break
    case 'array':
      expr.items.forEach(i => walkExpr(i, values, types))
      break
    case 'map':
      expr.entries.forEach(e => {
        walkExpr(e.key, values, types)
        walkExpr(e.value, values, types)
      })
      break
    case 'record':
      // a form constructor emits an object literal (no value import); its fields may reference more
      expr.fields.forEach(f => walkExpr(f.value, values, types))
      break
    case 'member':
      walkExpr(expr.target, values, types)
      break
    case 'await':
      walkExpr(expr.expr, values, types)
      break
    case 'closure':
      expr.params.forEach(p => walkType(p.type, types))
      walkType(expr.result, types)
      walkStatements(expr.body, values, types)
      break
    case 'conditional':
      expr.branches.forEach(b => {
        walkExpr(b.cond, values, types)
        walkExpr(b.value, values, types)
      })

      if (expr.otherwise) {
        walkExpr(expr.otherwise, values, types)
      }

      break
    default:
      break
  }
}

function walkStatements(
  statements: Statement[],
  values: Set<string>,
  types: Set<string>,
): void {
  for (const statement of statements) {
    walkStatement(statement, values, types)
  }
}

// collect cross-module references in a statement (its expressions and its type annotations)
function walkStatement(
  statement: Statement,
  values: Set<string>,
  types: Set<string>,
): void {
  switch (statement.form) {
    case 'let':
      walkExpr(statement.init, values, types)
      walkType(statement.type, types)
      break
    case 'assign':
      walkExpr(statement.target, values, types)
      walkExpr(statement.value, values, types)
      break
    case 'expression':
      walkExpr(statement.expr, values, types)
      break
    case 'if':
      statement.branches.forEach(b => {
        walkExpr(b.cond, values, types)
        walkStatements(b.body, values, types)
      })

      if (statement.otherwise) {
        walkStatements(statement.otherwise, values, types)
      }

      break
    case 'while':
      walkExpr(statement.cond, values, types)
      walkStatements(statement.body, values, types)
      break
    case 'match':
      walkExpr(statement.subject, values, types)
      statement.cases.forEach(c =>
        walkStatements(c.body, values, types),
      )

      if (statement.otherwise) {
        walkStatements(statement.otherwise, values, types)
      }

      break
    case 'for-each':
      walkExpr(statement.iterable, values, types)
      walkStatements(statement.body, values, types)
      break
    case 'return':
      if (statement.value) {
        walkExpr(statement.value, values, types)
      }

      break
    case 'throw':
      walkExpr(statement.value, values, types)
      break
    case 'hold':
      walkExpr(statement.expr, values, types)
      break
    case 'function':
      statement.params.forEach(p => walkType(p.type, types))
      walkType(statement.result, types)
      walkStatements(statement.body, values, types)
      break
    case 'record-type':
      statement.fields.forEach(f => walkType(f.type, types))
      statement.variants.forEach(v =>
        v.fields.forEach(f => walkType(f.type, types)),
      )
      break
    case 'instance':
      // a trait impl references the trait and the target type
      types.add(statement.mask)
      types.add(statement.target)
      break
    default:
      break
  }
}

// the file each top-level name is defined in. Last definition wins (mirrors `emitTypeScript`'s last-of-(form,name)
// dedup), which for native delegation resolves a name to its concrete impl, loaded after the abstract signature.
function definedNames(
  program: Program,
  origin: WeakMap<Statement, string> | undefined,
): { values: Map<string, string>; types: Map<string, string> } {
  const values = new Map<string, string>()
  const types = new Map<string, string>()

  for (const statement of program) {
    const file = origin?.get(statement) ?? ENTRY

    if (statement.form === 'function' || statement.form === 'zone') {
      values.set(statement.name, file)
    } else if (
      statement.form === 'record-type' ||
      statement.form === 'mask'
    ) {
      types.set(statement.name, file)
    }
  }

  return { values, types }
}

// one emitted module: its JS (well, TS) code, the source files it imports (the dependency edges the dev server's
// module graph + HMR need), and whether it is a `zone` module (a self-accepting HMR boundary)
export interface ModuleEmit {
  code: string
  imports: string[]
  isZone: boolean
}

// the render-runtime names a zone module's emitted code calls but that never appear as call nodes in its AST (emitZone
// synthesizes them, as does the HMR wiring). They are added to the module's value imports so the dev server resolves
// them to their real source modules. The first group is the view ABI; the second is the hot-reload bookkeeping.
const ZONE_MODULE_RUNTIME = [
  'element',
  'text',
  'dynamic',
  'attribute',
  'event',
  'append',
  'show',
  'each',
  'open-scope',
  'close-scope',
  'make-signal',
  'read-signal',
  'dispose-scope',
  'remove',
]

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
  origin: WeakMap<Statement, string> | undefined,
  urlForFile: (file: string) => string,
): Map<string, ModuleEmit> {
  // group statements by their source file, preserving program order within each file
  const byFile = new Map<string, Statement[]>()

  for (const statement of program) {
    const file = origin?.get(statement) ?? ENTRY
    const bucket = byFile.get(file)

    if (bucket) {
      bucket.push(statement)
    } else {
      byFile.set(file, [statement])
    }
  }

  const defined = definedNames(program, origin)
  // every enum variant name across all modules, so a module building `make some` emits the `form` discriminant even
  // when the enum (`maybe`) is defined in another module
  const variants = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'record-type') {
      for (const v of statement.variants) {
        variants.add(v.name)
      }
    }
  }

  const out = new Map<string, ModuleEmit>()

  for (const [file, statements] of byFile) {
    const values = new Set<string>()
    const types = new Set<string>()
    walkStatements(statements, values, types)

    // a zone module is a self-accepting HMR boundary: it emits state-preserving hot wiring (see below), which calls a
    // few render-runtime helpers that are not otherwise in the module's AST. Add them so they get imported.
    const isZone = statements.some(s => s.form === 'zone')

    if (isZone) {
      for (const helper of ZONE_MODULE_RUNTIME) {
        values.add(helper)
      }
    }

    // group cross-module references by their defining file
    const valueImports = new Map<string, Set<string>>()
    const typeImports = new Map<string, Set<string>>()

    for (const name of values) {
      const from = defined.values.get(name)

      if (from && from !== file) {
        groupAdd(valueImports, from, toCamel(name))
      }
    }

    for (const name of types) {
      const from = defined.types.get(name)

      if (from && from !== file) {
        groupAdd(typeImports, from, toPascal(name))
      }
    }

    const lines: string[] = []

    for (const [dep, names] of valueImports) {
      lines.push(
        `import { ${[...names].sort().join(', ')} } from "${urlForFile(dep)}"`,
      )
    }

    for (const [dep, names] of typeImports) {
      lines.push(
        `import type { ${[...names]
          .sort()
          .join(', ')} } from "${urlForFile(dep)}"`,
      )
    }

    // zone modules emit HMR-aware component bodies (signals seeded from the kept snapshot, instances registered)
    const body = emitTypeScript(statements, { hmr: isZone, variants })
    const depFiles = new Set<string>([
      ...valueImports.keys(),
      ...typeImports.keys(),
    ])

    const pieces = [
      lines.join('\n'),
      isZone ? hotPrelude() : '',
      body,
      isZone ? hotEpilogue() : '',
    ].filter(Boolean)

    out.set(file, {
      code: pieces.join('\n\n'),
      imports: [...depFiles],
      isZone,
    })
  }

  return out
}

function groupAdd(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const set = map.get(key)

  if (set) {
    set.add(value)
  } else {
    map.set(key, new Set([value]))
  }
}
