// Declarative native bindings (`bind <name>` with per-environment `case <env>` templates). A bind is a stdlib leaf: it
// has no body to lower, so each backend renders the matching environment's native expression at the call site instead
// of emitting a function. The verb that dispatches to a bind folds away under specialization (code/ir/simplify.ts),
// leaving a direct bind call. See note/research/vibe/computation/plans/20-specialization-and-bind.md. Pure and
// browser-safe.

import type { Statement } from '@/code/compile/node'

export type Bind = Extract<Statement, { form: 'bind' }>

// index every declarative binding by name, for call-site rendering across a program
export function collectBinds(program: Array<Statement>): Map<string, Bind> {
  const binds = new Map<string, Bind>()
  for (const statement of program)
    if (statement.form === 'bind') binds.set(statement.name, statement)
  return binds
}

// render a bind's native expression for one environment: substitute each `$param` placeholder with the already-emitted
// argument string. Returns undefined when the bind declares no target for this environment (the backend emits a gap).
export function renderBind(
  bind: Bind,
  env: string,
  args: Array<string>,
): string | undefined {
  const target = bind.targets.find(candidate => candidate.env === env)
  if (!target) return undefined
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
): Array<{ module: string; alias?: string }> {
  const seen = new Set<string>()
  const out: Array<{ module: string; alias?: string }> = []
  for (const bind of binds.values()) {
    const target = bind.targets.find(candidate => candidate.env === env)
    for (const need of target?.imports ?? []) {
      const key = `${need.module}|${need.alias ?? ''}`
      if (seen.has(key)) continue
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
