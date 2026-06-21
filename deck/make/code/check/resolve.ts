// The resolver: bind every name to its definition. Walks the compile AST with a scope stack, attaches a binding
// to each variable, handles forward references to functions, and reports unknown names with a did-you-mean. An
// unresolved name that is not legally runtime-deferred becomes an unknown-name diagnostic. This is the hole-filling
// pass (the part that fills name and import holes). See note/research/vibe/computation/plans/11-elaboration.md.

import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import {
  diagnose,
  nearest,
} from '@cluesurf/make/code/parser/diagnostic'
import type {
  Binding,
  Expression,
  Program,
  Statement,
  ZoneNode,
} from '@cluesurf/make/code/compile/node'

export type Scope = Map<string, Binding>

// the JS intrinsics the generated bindings (bind.tree's native.tree) use to express operators, control flow, and
// dynamic member access. They are not user definitions; the backend lowers them to real operations. Always in scope.
const INTRINSICS = [
  'native-test',
  'native-test-else',
  'debug',
  'compute-binary-operation',
  'compute-prefixed-unary-operation',
  'call-keyword',
  'set-dynamic-aspect',
  'get-dynamic-aspect',
  'delete-dynamic-aspect',
  'try',
]

// build the global scope: top-level functions (+ form method bare-names), native aliases, and the intrinsics. Pure
// over the program, so the incremental compiler builds it once and reuses it to resolve each definition in isolation.
// See note/seed/plan/functional-checker.md (Tier 2, stage 1).
export function buildGlobalScope(program: Program): Scope {
  const global: Scope = new Map()

  for (const statement of program) {
    if (statement.form === 'function') {
      global.set(statement.name, {
        kind: 'function',
        arity: statement.params.length,
      })

      // a form method is callable by its bare name (`call unwrap-or`); receiver dispatch picks the form later.
      // a real top-level function of the same name wins, so only register the bare name if it is still free.
      if (statement.method && !global.has(statement.method.name)) {
        global.set(statement.method.name, {
          kind: 'function',
          arity: statement.params.length,
        })
      }
    } else if (statement.form === 'bind') {
      // a declarative native binding is callable by name like a function
      global.set(statement.name, {
        kind: 'function',
        arity: statement.params.length,
      })
    } else if (statement.form === 'native') {
      // a native module alias (from `dock load`) is a defined name; member calls on it are the FFI
      global.set(statement.alias, { kind: 'deferred' })
    }
  }

  for (const intrinsic of INTRINSICS)
    {global.set(intrinsic, { kind: 'builtin' })}

  return global
}

export function resolve(
  program: Program,
  file: string,
  origin?: WeakMap<Statement, string>,
  // incremental hooks (default = whole-program, unchanged): `scope` reuses a prebuilt global scope instead of building
  // one; `only` resolves just that one function. The per-definition path passes both. See functional-checker.md.
  options?: { scope?: Scope; only?: string },
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  // the file currently being resolved. With a merged multi-module program, `file` is only the entry; `origin` maps
  // each top-level statement back to the module it came from, so an unknown-name error points at the real source.
  let currentFile = file

  // the global scope, prebuilt (incremental path) or built now from the whole program (whole-program path)
  const global = options?.scope ?? buildGlobalScope(program)

  const stack: Scope[] = [global]

  // variant name -> its field names, so a `case <variant>` branch can bind them as locals (a match on `succ p`
  // exposes `p` in that branch)
  const variantFields = new Map<string, string[]>()

  for (const statement of program)
    {if (statement.form === 'record-type')
      {for (const variant of statement.variants)
        {variantFields.set(
          variant.name,
          variant.fields.map(f => f.name),
        )}}}

  const look = (name: string): Binding | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const found = stack[i]!.get(name)

      if (found) {return found}
    }

    return undefined
  }

  const known = (): string[] => {
    const names = new Set<string>()

    for (const scope of stack)
      {for (const name of scope.keys()) {names.add(name)}}

    return [...names]
  }

  const declare = (name: string, binding: Binding) => {
    stack[stack.length - 1]!.set(name, binding)
  }

  function resolveExpression(node: Expression): void {
    switch (node.form) {
      case 'variable': {
        const binding = look(node.name)

        if (binding) {
          node.binding = binding
        } else {
          const suggestion = nearest(node.name, known())
          diagnostics.push(
            diagnose('unknown-name', {
              file: currentFile,
              span: node.span,
              message: `the name "${node.name}" is not defined`,
              hint: suggestion
                ? `did you mean "${suggestion}"?`
                : undefined,
            }),
          )
        }

        break
      }

      case 'binary':
        resolveExpression(node.left)
        resolveExpression(node.right)
        break
      case 'unary':
        resolveExpression(node.operand)
        break
      case 'call':
        resolveExpression(node.callee)

        for (const arg of node.args) {resolveExpression(arg)}

        break
      case 'array':
        for (const item of node.items) {resolveExpression(item)}

        break
      case 'map':
        for (const entry of node.entries) {
          resolveExpression(entry.key)
          resolveExpression(entry.value)
        }

        break
      case 'record':
        for (const field of node.fields) {resolveExpression(field.value)}

        break
      case 'member':
        resolveExpression(node.target)
        break
      case 'await':
        resolveExpression(node.expr)
        break

      case 'closure': {
        // a function literal (a callback, e.g. an effect's `run`): resolve its body with its params in scope, so names
        // used only inside the closure still get their binding (needed for unknown-name checks and import collection)
        stack.push(new Map())

        for (const param of node.params)
          {declare(param.name, { kind: 'parameter' })}

        for (const statement of node.body) {resolveStatement(statement)}

        stack.pop()
        break
      }

      case 'conditional':
        for (const branch of node.branches) {
          resolveExpression(branch.cond)
          resolveExpression(branch.value)
        }

        if (node.otherwise) {resolveExpression(node.otherwise)}

        break
      default:
        break
    }
  }

  function resolveBody(body: Statement[]): void {
    stack.push(new Map())

    for (const statement of body) {resolveStatement(statement)}

    stack.pop()
  }

  function resolveStatement(node: Statement): void {
    switch (node.form) {
      case 'let':
        resolveExpression(node.init)
        declare(node.name, { kind: 'local' })
        break
      case 'assign':
        resolveExpression(node.target)
        resolveExpression(node.value)
        break
      case 'expression':
        resolveExpression(node.expr)
        break
      case 'return':
        if (node.value) {resolveExpression(node.value)}

        break
      case 'while':
        resolveExpression(node.cond)
        resolveBody(node.body)
        break
      case 'if':
        for (const branch of node.branches) {
          resolveExpression(branch.cond)
          resolveBody(branch.body)
        }

        if (node.otherwise) {resolveBody(node.otherwise)}

        break
      case 'for-each':
        resolveExpression(node.iterable)
        stack.push(new Map())
        declare(node.item, { kind: 'local' })

        for (const statement of node.body) {resolveStatement(statement)}

        stack.pop()
        break
      case 'match':
        resolveExpression(node.subject)

        for (const branch of node.cases) {
          stack.push(new Map())

          // bind the matched variant's fields as locals for this branch
          for (const fieldName of variantFields.get(branch.label) ?? [])
            {declare(fieldName, { kind: 'local' })}

          for (const statement of branch.body)
            {resolveStatement(statement)}

          stack.pop()
        }

        if (node.otherwise) {resolveBody(node.otherwise)}

        break
      case 'hold':
        resolveExpression(node.expr)
        break
      case 'throw':
        resolveExpression(node.value)
        break
      case 'break':
      case 'continue':
      case 'record-type':
      case 'mask':
      case 'instance':
        break

      case 'function': {
        stack.push(new Map())

        for (const param of node.params)
          {declare(param.name, { kind: 'parameter' })}

        for (const statement of node.body) {resolveStatement(statement)}

        stack.pop()
        break
      }

      // a zone (view component): resolve names in its body the same as a function (params in scope, `save` declares).
      // Element refs (`zone input / name x`) are pre-declared so an event handler can read a ref defined anywhere.
      case 'zone': {
        stack.push(new Map())

        for (const param of node.params)
          {declare(param.name, { kind: 'parameter' })}

        for (const ref of collectZoneRefs(node.body))
          {declare(ref, { kind: 'local' })}

        resolveZoneNodes(node.body)
        stack.pop()
        break
      }
    }
  }

  // every element ref (`name x`) anywhere in a zone's view tree, so they can be declared up front
  function collectZoneRefs(nodes: ZoneNode[]): string[] {
    const refs: string[] = []

    const walk = (list: ZoneNode[]): void => {
      for (const node of list) {
        if (node.form === 'element') {
          if (node.ref) {refs.push(node.ref)}

          walk(node.children)
        } else if (node.form === 'fork') {
          for (const branch of node.branches) {walk(branch.body)}

          if (node.otherwise) {walk(node.otherwise)}
        } else if (node.form === 'walk') {walk(node.body)}
      }
    }

    walk(nodes)

    return refs
  }

  // resolve names inside a zone's view tree: attribute / event / read expressions, `save` (which declares a local),
  // and the recursive children / branches / list bodies
  function resolveZoneNodes(nodes: ZoneNode[]): void {
    for (const node of nodes) {
      switch (node.form) {
        case 'element':
          for (const attribute of node.attributes)
            {resolveExpression(attribute.value)}

          for (const prop of node.props) {resolveExpression(prop.value)}

          resolveZoneNodes(node.children)
          break
        case 'read':
          resolveExpression(node.value)
          break
        case 'save':
          resolveExpression(node.value)
          declare(node.name, { kind: 'local' })
          break
        case 'fork':
          for (const branch of node.branches) {
            resolveExpression(branch.cond)
            stack.push(new Map())
            resolveZoneNodes(branch.body)
            stack.pop()
          }

          if (node.otherwise) {
            stack.push(new Map())
            resolveZoneNodes(node.otherwise)
            stack.pop()
          }

          break
        case 'walk':
          resolveExpression(node.iterable)
          stack.push(new Map())
          declare(node.item, { kind: 'local' })
          resolveZoneNodes(node.body)
          stack.pop()
          break
        case 'text':
        case 'slot':
          break
      }
    }
  }

  for (const statement of program) {
    currentFile = origin?.get(statement) ?? file

    // incremental: resolve only the requested function's body (the global scope already has every name)
    if (
      options?.only !== undefined &&
      !(
        statement.form === 'function' && statement.name === options.only
      )
    )
      {continue}

    resolveStatement(statement)
  }

  return diagnostics
}
