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
} from '@/code/compile/node'
import {
  emitTypeScript,
  toCamel,
  toPascal,
} from '@/code/compile/typescript'

const ENTRY = '<entry>'

// collect the named-type references inside a type (for `import type`)
function walkType(type: Type | undefined, types: Set<string>): void {
  if (!type) return
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
      if (expr.binding?.kind === 'function') values.add(expr.name)
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
    default:
      break
  }
}

function walkStatements(
  statements: Array<Statement>,
  values: Set<string>,
  types: Set<string>,
): void {
  for (const statement of statements)
    walkStatement(statement, values, types)
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
      if (statement.otherwise)
        walkStatements(statement.otherwise, values, types)
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
      if (statement.otherwise)
        walkStatements(statement.otherwise, values, types)
      break
    case 'for-each':
      walkExpr(statement.iterable, values, types)
      walkStatements(statement.body, values, types)
      break
    case 'return':
      if (statement.value) walkExpr(statement.value, values, types)
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
    if (statement.form === 'function' || statement.form === 'zone')
      values.set(statement.name, file)
    else if (
      statement.form === 'record-type' ||
      statement.form === 'mask'
    )
      types.set(statement.name, file)
  }
  return { values, types }
}

// one emitted module: its JS (well, TS) code, the source files it imports (the dependency edges the dev server's
// module graph + HMR need), and whether it is a `zone` module (a self-accepting HMR boundary)
export interface ModuleEmit {
  code: string
  imports: Array<string>
  isZone: boolean
}

// emit one ESM module per source file. `urlForFile` maps a source file to the URL the browser imports it by. Returns,
// per source file, the emitted code plus its dependency edges and zone flag (for the dev server's graph + HMR).
export function emitModules(
  program: Program,
  origin: WeakMap<Statement, string> | undefined,
  urlForFile: (file: string) => string,
): Map<string, ModuleEmit> {
  // group statements by their source file, preserving program order within each file
  const byFile = new Map<string, Array<Statement>>()
  for (const statement of program) {
    const file = origin?.get(statement) ?? ENTRY
    const bucket = byFile.get(file)
    if (bucket) bucket.push(statement)
    else byFile.set(file, [statement])
  }

  const defined = definedNames(program, origin)
  const out = new Map<string, ModuleEmit>()

  for (const [file, statements] of byFile) {
    const values = new Set<string>()
    const types = new Set<string>()
    walkStatements(statements, values, types)

    // group cross-module references by their defining file
    const valueImports = new Map<string, Set<string>>()
    const typeImports = new Map<string, Set<string>>()
    for (const name of values) {
      const from = defined.values.get(name)
      if (from && from !== file) groupAdd(valueImports, from, toCamel(name))
    }
    for (const name of types) {
      const from = defined.types.get(name)
      if (from && from !== file) groupAdd(typeImports, from, toPascal(name))
    }

    const lines: Array<string> = []
    for (const [dep, names] of valueImports)
      lines.push(
        `import { ${[...names].sort().join(', ')} } from "${urlForFile(dep)}"`,
      )
    for (const [dep, names] of typeImports)
      lines.push(
        `import type { ${[...names]
          .sort()
          .join(', ')} } from "${urlForFile(dep)}"`,
      )

    const body = emitTypeScript(statements)
    const depFiles = new Set<string>([
      ...valueImports.keys(),
      ...typeImports.keys(),
    ])
    out.set(file, {
      code: lines.length ? `${lines.join('\n')}\n\n${body}` : body,
      imports: [...depFiles],
      isZone: statements.some(s => s.form === 'zone'),
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
  if (set) set.add(value)
  else map.set(key, new Set([value]))
}
