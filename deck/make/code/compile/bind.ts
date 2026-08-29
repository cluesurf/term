// Declarative native bindings (`bind <name>` with per-environment `case <env>` templates). A bind is a stdlib leaf: it
// has no body to lower, so each backend renders the matching environment's native expression at the call site instead
// of emitting a function. The verb that dispatches to a bind folds away under specialization (code/ir/simplify.ts),
// leaving a direct bind call. See note/research/vibe/computation/plans/20-specialization-and-bind.md. Pure and
// browser-safe.

import type {
  Expression,
  Statement,
} from '@term/make/code/compile/node'

export type Bind = Extract<Statement, { form: 'bind' }>

// index every declarative binding by name, for call-site rendering across a program
export function collectBinds(program: Statement[]): Map<string, Bind> {
  const binds = new Map<string, Bind>()

  for (const statement of program) {
    if (statement.form === 'bind') {
      binds.set(statement.name, statement)
    }
  }

  return binds
}

// the subset of `binds` actually called somewhere in the program. A backend imports only these: a program that calls
// only `digest-sha256` must not pull in `digest-md5`'s `use md5::Digest;` (which would collide with `sha2::Digest`).
export function referencedBinds(
  program: Statement[],
  binds: Map<string, Bind>,
): Map<string, Bind> {
  const used = new Set<string>()

  const expr = (node: Expression | undefined): void => {
    if (!node) {
      return
    }

    switch (node.form) {
      case 'call':
        if (
          node.callee.form === 'variable' &&
          binds.has(node.callee.name)
        ) {
          used.add(node.callee.name)
        }

        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'array':
        node.items.forEach(expr)
        break
      case 'map':
        node.entries.forEach(e => {
          expr(e.key)
          expr(e.value)
        })
        break
      case 'record':
        node.fields.forEach(f => expr(f.value))
        break
      case 'member':
        expr(node.target)
        break
      case 'await':
        expr(node.expr)
        break
      case 'template':
        for (const part of node.parts) {
          if (typeof part !== 'string') {
            expr(part)
          }
        }

        break
      case 'closure':
        body(node.body)
        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond)
          expr(b.value)
        })
        expr(node.otherwise)
        break
      default:
        break
    }
  }

  const one = (statement: Statement): void => {
    switch (statement.form) {
      case 'let':
        expr(statement.init)
        break
      case 'assign':
        expr(statement.target)
        expr(statement.value)
        break
      case 'expression':
        expr(statement.expr)
        break
      case 'if':
        statement.branches.forEach(b => {
          expr(b.cond)
          body(b.body)
        })

        if (statement.otherwise) {
          body(statement.otherwise)
        }

        break
      case 'while':
        expr(statement.cond)
        body(statement.body)
        break
      case 'match':
        expr(statement.subject)
        statement.cases.forEach(c => body(c.body))

        if (statement.otherwise) {
          body(statement.otherwise)
        }

        break
      case 'for-each':
        expr(statement.iterable)
        body(statement.body)
        break
      case 'return':
        expr(statement.value)
        break
      case 'throw':
        expr(statement.value)
        break
      case 'hold':
        expr(statement.expr)
        break
      case 'function':
        body(statement.body)
        break
      default:
        break
    }
  }

  const body = (statements: Statement[]): void =>
    statements.forEach(one)

  body(program)

  const out = new Map<string, Bind>()

  for (const name of used) {
    const bind = binds.get(name)

    if (bind) {
      out.set(name, bind)
    }
  }

  return out
}

// render a bind's native expression for one environment: substitute each `$param` placeholder with the already-emitted
// argument string. Returns undefined when the bind declares no target for this environment (the backend emits a gap).
export function renderBind(
  bind: Bind,
  env: string,
  args: string[],
): string | undefined {
  const target = bind.targets.find(candidate => candidate.env === env)

  if (!target) {
    return undefined
  }

  let out = target.expression
  bind.params.forEach((param, index) => {
    out = out.split(`$${param.name}`).join(args[index] ?? '')
  })

  return out
}

// the distinct imports every bind in the program needs for one environment, in first-seen order. A backend emits these
// alongside its native-dock imports (e.g. swift `import Foundation` for `Foundation.pow`).
export function bindImports(
  binds: Map<string, Bind>,
  env: string,
): { module: string; alias?: string }[] {
  const seen = new Set<string>()
  const out: { module: string; alias?: string }[] = []

  for (const bind of binds.values()) {
    const target = bind.targets.find(candidate => candidate.env === env)

    for (const need of target?.imports ?? []) {
      const key = `${need.module}|${need.alias ?? ''}`

      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      out.push(need)
    }
  }

  return out
}

// the gap a backend emits when a called bind has no target for the environment it is emitting: an undefined sentinel
// identifier, so the generated source fails to compile loudly (a stdlib author forgot a backend) rather than silently
// calling a nonexistent function. The name carries the greppable SEED_UNSUPPORTED tag and the bind it came from. This
// is a hard error on purpose: every backend a bind is used on must declare a `case`.
export function bindGap(name: string): string {
  return `SEED_UNSUPPORTED_BIND_${name.replace(/[^A-Za-z0-9]/g, '_')}`
}
