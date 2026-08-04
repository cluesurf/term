// The HVM backend: emit the pure numeric / boolean / recursive fragment as HVM (the interaction-combinator runtime, so
// the same program reduces in parallel and beta-optimally). A Seed function becomes an HVM definition `@name = λ&p. body`
// (parameters are auto-dup `&` so they can be used more than once on a linear substrate); arithmetic and comparison
// lower to HVM's native operators; an `if` / value-conditional lowers to a numeric match `(λ{0: else; _: λx. then})(cond)`;
// a call lowers to `@callee(args)`. Recursion is just a self-reference to `@name`. Forms outside this fragment (strings,
// collections, closures stored in data, records, loops) are flagged with a SEED-UNSUPPORTED marker, exactly like the
// WGSL backend. Run monomorphization first so a generic call resolves to a concrete definition. Pure,
// browser-safe. Experimental: see backend-registry.ts.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'
import { monomorphize } from '@term/make/code/ir/monomorphize'
import { experimentalBanner } from '@term/make/code/compile/backend-registry'

const NOWHERE: Span = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 },
}

// HVM identifiers are alphanumeric + underscore; seed kebab-case names map by replacing hyphens.
function name(text: string): string {
  return text.replace(/-/g, '_')
}

// seed binary operator -> HVM operator. Equality is `===` in HVM; the arithmetic and ordering operators match.
const OP: Record<string, string | undefined> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>=',
  '==': '===',
  '&&': '&&',
  '||': '||',
}

export function emitHvm(input: Program): string {
  // HVM has no type parameters: specialize every generic function at its concrete call types first, so a generic call
  // resolves to a real monomorphic definition rather than being skipped.
  const program = monomorphize(input)

  // forms we could not lower, collected so the module header can report them once (HVM has no inline block comments)
  const unsupported: string[] = []

  let fresh = 0

  const mark = (form: string): string => {
    if (!unsupported.includes(form)) {
      unsupported.push(form)
    }

    // a parseable placeholder so the rest of the module still reduces; the header lists what was dropped
    return '0'
  }

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        return String(node.value)
      case 'boolean':
        return node.value ? '1' : '0'
      case 'unit':
      case 'null':
        return '0'
      case 'variable':
        return name(node.name)

      case 'binary': {
        const op = OP[node.op]

        if (!op) {
          return mark(`binary "${node.op}"`)
        }

        return `(${expr(node.left)} ${op} ${expr(node.right)})`
      }

      case 'unary':
        // arithmetic negation; logical not maps a 0/1 through the same match an `if` uses
        if (node.op === '-') {
          return `(0 - ${expr(node.operand)})`
        }

        if (node.op === '!') {
          return `(λ{0: 1; _: λ_. 0})(${expr(node.operand)})`
        }

        return mark(`unary "${node.op}"`)

      case 'call': {
        // a call to a named function -> `@callee(args)`. (Arithmetic has already been lowered to `binary`.)
        if (node.callee.form === 'variable') {
          const args = node.args.map(expr).join(', ')

          return `@${name(node.callee.name)}(${args})`
        }

        return mark('call (computed callee)')
      }

      case 'conditional':
        return conditional(node.branches, node.otherwise)

      case 'await':
        return expr(node.expr)

      default:
        return mark(node.form)
    }
  }

  // a chain of cond ? value branches with a final else, as nested numeric matches: `(λ{0: else; _: λx. then})(cond)`.
  // HVM matches a number: branch `0` is the false case; the `_` default (binding the value) is the true (non-zero) case.
  const conditional = (
    branches: { cond: Expression; value: Expression }[],
    otherwise: Expression | undefined,
  ): string => {
    const elseValue = otherwise ? expr(otherwise) : '0'

    return branches.reduceRight((rest, branch) => {
      // the `_` default binds the scrutinee (the condition's value); the branch usually ignores it, so bind it auto-dup
      // (`&`) -- on the linear substrate that lets zero uses erase cleanly instead of leaving a dangling variable.
      const slot = `c${fresh++}`

      return `(λ{0: ${rest}; _: λ&${slot}. ${expr(
        branch.value,
      )}})(${expr(branch.cond)})`
    }, elseValue)
  }

  // a function body in the pure fragment is a single returned value, or an `if` whose branches return. Anything else
  // (loops, in-place mutation, multi-statement let chains) is outside this target's fragment.
  const body = (statements: Statement[]): string => {
    if (statements.length === 1) {
      const only = statements[0]!

      if (only.form === 'return') {
        return only.value ? expr(only.value) : '0'
      }

      if (only.form === 'if') {
        const branches = only.branches.map(b => ({
          cond: b.cond,
          value: returnedValue(b.body),
        }))
        const otherwise = only.otherwise
          ? returnedValue(only.otherwise)
          : undefined

        return conditional(branches, otherwise)
      }

      if (only.form === 'expression') {
        return expr(only.expr)
      }
    }

    return mark('multi-statement body')
  }

  // the single expression a branch body returns (the pure fragment), or a placeholder marker
  const returnedValue = (statements: Statement[]): Expression => {
    const only = statements.length === 1 ? statements[0] : undefined

    if (only?.form === 'return' && only.value) {
      return only.value
    }

    if (only?.form === 'if') {
      // a nested if in a branch: wrap it back into a conditional expression node so `expr` handles it uniformly
      return {
        form: 'conditional',
        branches: only.branches.map(b => ({
          cond: b.cond,
          value: returnedValue(b.body),
        })),
        otherwise: only.otherwise
          ? returnedValue(only.otherwise)
          : undefined,
        span: only.span,
      }
    }

    const span = statements[0]?.span ?? NOWHERE

    return { form: 'integer', value: 0, span }
  }

  const definition = (
    fn: Extract<Statement, { form: 'function' }>,
  ): string => {
    // each parameter is an auto-dup lambda so the body may use it any number of times on the linear substrate
    const lambdas = fn.params.map(p => `λ&${name(p.name)}.`).join(' ')
    const value = body(fn.body)

    return `@${name(fn.name)} = ${lambdas}${
      lambdas ? ' ' : ''
    }${value}`
  }

  const definitions: string[] = []

  for (const statement of program) {
    if (statement.form === 'function') {
      definitions.push(definition(statement))
    } else if (
      statement.form === 'record-type' ||
      statement.form === 'mask' ||
      statement.form === 'instance' ||
      statement.form === 'native' ||
      statement.form === 'bind' ||
      statement.form === 'zone'
    ) {
      // declarations with no runtime value in this fragment; skip silently (they carry no HVM definition)
    } else {
      mark(statement.form)
    }
  }

  const header = unsupported.length
    ? `// SEED-UNSUPPORTED on HVM (outside the numeric/recursive fragment): ${unsupported.join(
        ', ',
      )}\n`
    : ''

  return (
    experimentalBanner('hvm', '//') +
    header +
    definitions.join('\n\n') +
    '\n'
  )
}
