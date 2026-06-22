// Structural equality and stability for expressions, shared by the lint rules that ask whether two subexpressions are
// "the same" (no-self-comparison, no-duplicate-branch-condition, no-self-assignment).
//
// `expressionsEqual` is purely structural: same shape, same literals, same names, ignoring spans / types / bindings.
// `isStable` is true when an expression reads no call or await, so evaluating it twice yields the same value. A rule
// that flags a "duplicate" or "self" pattern fires only on stable expressions, so an intentional pair of effectful
// calls (`if next() ... else if next() ...`) is never misreported.

import type {
  Expression,
  Statement,
} from '@cluesurf/make/code/compile/node'

export function expressionsEqual(
  a: Expression,
  b: Expression,
): boolean {
  if (a.form !== b.form) {
    return false
  }

  switch (a.form) {
    case 'integer':
      // value is number | bigint; compare by string so 5 and 5n match
      return String(a.value) === String((b as typeof a).value)
    case 'float':
      return a.value === (b as typeof a).value
    case 'boolean':
      return a.value === (b as typeof a).value
    case 'string':
      return a.value === (b as typeof a).value
    case 'null':
    case 'unit':
      return true
    case 'variable':
      return a.name === (b as typeof a).name
    case 'member': {
      const o = b as typeof a
      return a.name === o.name && expressionsEqual(a.target, o.target)
    }
    case 'binary': {
      const o = b as typeof a
      return (
        a.op === o.op &&
        expressionsEqual(a.left, o.left) &&
        expressionsEqual(a.right, o.right)
      )
    }
    case 'unary': {
      const o = b as typeof a
      return a.op === o.op && expressionsEqual(a.operand, o.operand)
    }
    case 'call': {
      const o = b as typeof a
      return (
        expressionsEqual(a.callee, o.callee) &&
        a.args.length === o.args.length &&
        a.args.every((arg, i) => expressionsEqual(arg, o.args[i]!))
      )
    }
    case 'array': {
      const o = b as typeof a
      return (
        a.items.length === o.items.length &&
        a.items.every((item, i) => expressionsEqual(item, o.items[i]!))
      )
    }
    default:
      // records, maps, closures, conditionals, etc. are treated as not-equal: too rarely duplicated to be worth the
      // surface, and defaulting to false keeps every dependent rule from over-reporting
      return false
  }
}

// structural equality for two statement lists (a block). Used by no-identical-branches to tell when a fork's two
// branches run exactly the same code.
export function statementListsEqual(
  a: Statement[],
  b: Statement[],
): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => statementsEqual(s, b[i]!))
  )
}

function optionalListsEqual(
  a: Statement[] | undefined,
  b: Statement[] | undefined,
): boolean {
  if (!a || !b) {
    return !a && !b
  }

  return statementListsEqual(a, b)
}

// structural equality for two statements. Handles the common branch-body forms and recurses into nested blocks;
// any form not covered returns false, so the dependent rule only ever fires on a fully-recognized exact match.
export function statementsEqual(a: Statement, b: Statement): boolean {
  if (a.form !== b.form) {
    return false
  }

  switch (a.form) {
    case 'expression':
      return expressionsEqual(a.expr, (b as typeof a).expr)
    case 'return': {
      const o = b as typeof a
      if (!a.value || !o.value) {
        return !a.value && !o.value
      }

      return expressionsEqual(a.value, o.value)
    }
    case 'throw':
      return expressionsEqual(a.value, (b as typeof a).value)
    case 'assign': {
      const o = b as typeof a
      return (
        a.op === o.op &&
        expressionsEqual(a.target, o.target) &&
        expressionsEqual(a.value, o.value)
      )
    }
    case 'let': {
      const o = b as typeof a
      return (
        a.name === o.name &&
        !!a.mutable === !!o.mutable &&
        expressionsEqual(a.init, o.init)
      )
    }
    case 'break':
    case 'continue':
    case 'exit':
      return true
    case 'while': {
      const o = b as typeof a
      return (
        expressionsEqual(a.cond, o.cond) &&
        statementListsEqual(a.body, o.body)
      )
    }
    case 'if': {
      const o = b as typeof a
      return (
        a.branches.length === o.branches.length &&
        a.branches.every(
          (br, i) =>
            expressionsEqual(br.cond, o.branches[i]!.cond) &&
            statementListsEqual(br.body, o.branches[i]!.body),
        ) &&
        optionalListsEqual(a.otherwise, o.otherwise)
      )
    }
    default:
      // for-each, match, hold, debug, function, ... : conservatively not-equal
      return false
  }
}

// true when the expression reads no call or await, so evaluating it twice is observationally identical. Conservative:
// any form not explicitly cleared (or whose children are not all stable) is treated as unstable.
export function isStable(node: Expression): boolean {
  switch (node.form) {
    case 'integer':
    case 'float':
    case 'boolean':
    case 'string':
    case 'null':
    case 'unit':
    case 'variable':
    case 'hole':
      return true
    case 'binary':
      return isStable(node.left) && isStable(node.right)
    case 'unary':
      return isStable(node.operand)
    case 'member':
      return isStable(node.target)
    case 'array':
      return node.items.every(isStable)
    default:
      // call, await, closure, record, map, conditional, slot, ... -- not provably side-effect-free
      return false
  }
}
