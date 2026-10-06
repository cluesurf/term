// WHAT A FAILED THEOREM WAS ASKED, AND WHETHER IT IS FALSE. A rule that is not proven used to say only that its goal
// "does not follow from what is known here", which cannot tell a false law from a true one the provers did not reach.
// This prints the goal and the hypotheses as the reader wrote them, and searches small values of the rule's marks for
// one where every hypothesis holds and the goal does not. Found, the law is FALSE, and the values say why: the
// counterexample Dafny's verifier gives, and the goal and facts Lean's infoview shows, in the build's own message.
//
// The search only evaluates. It cannot prove anything and it cannot forge a proof: a value it finds is checked by
// arithmetic on the rule as written, and none found means nothing. It runs only after a goal is NOT proven.

import type { Expression } from '@term/make/code/compile/node'

const OPS: Record<string, string> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '==': '==',
  '!=': '!=',
  '&&': 'and',
  '||': 'or',
}

// binding strength, so a printed expression needs no more parentheses than its meaning does
const STRENGTH: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '==': 3,
  '!=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
}

// an expression in ordinary infix, the way a reader would write it on paper
export function printExpression(e: Expression, outer = 0): string {
  switch (e.form) {
    case 'variable':
      return e.name
    case 'integer':
      return String(e.value)
    case 'unary':
      return e.op === '!' ? `not ${printExpression(e.operand, 6)}` : `${e.op}${printExpression(e.operand, 6)}`
    case 'binary': {
      const strength = STRENGTH[e.op] ?? 0
      const text = `${printExpression(e.left, strength)} ${OPS[e.op] ?? e.op} ${printExpression(e.right, strength + 1)}`

      return strength < outer ? `(${text})` : text
    }
    case 'call':
      return `${printExpression(e.callee, 7)}(${e.args.map(a => printExpression(a)).join(', ')})`
    case 'member':
      return `${printExpression(e.target, 7)}/${e.name}`
    case 'record': {
      // `zero`, `succ(prior: n)`: the case as written, its fields by name
      const name = e.name.replace(/^.*__/, '')

      return e.fields.length === 0
        ? name
        : `${name}(${e.fields.map(f => `${f.name}: ${printExpression(f.value)}`).join(', ')})`
    }
    default:
      return '…'
  }
}

type Value = number | boolean | undefined

// a task the search may run: one whose whole body is `back <expression>` of its parameters (`double`, `square`)
export type SmallTask = { params: string[]; body: Expression }

// calls nested deeper than this are not followed, so a recursive task cannot hold the search
const CALL_DEPTH = 32

// an expression's value at an assignment of its variables, or undefined where it reads anything else (a call of a
// task it may not run, a field, a division that does not come out whole)
function evaluate(e: Expression, at: Map<string, number>, tasks: Map<string, SmallTask> = new Map(), depth = 0): Value {
  switch (e.form) {
    case 'call': {
      const task = e.callee.form === 'variable' ? tasks.get(e.callee.name) : undefined

      if (!task || depth >= CALL_DEPTH || task.params.length !== e.args.length) {
        return undefined
      }

      const inner = new Map<string, number>()

      for (const [i, arg] of e.args.entries()) {
        const v = evaluate(arg, at, tasks, depth)

        if (typeof v !== 'number') {
          return undefined
        }

        inner.set(task.params[i]!, v)
      }

      return evaluate(task.body, inner, tasks, depth + 1)
    }
    case 'variable':
      return at.get(e.name)
    case 'integer':
      return Number(e.value)
    case 'unary': {
      const v = evaluate(e.operand, at, tasks, depth)

      if (e.op === '!') {
        return typeof v === 'boolean' ? !v : undefined
      }

      return typeof v === 'number' && e.op === '-' ? -v : undefined
    }
    case 'binary': {
      const l = evaluate(e.left, at, tasks, depth)
      const r = evaluate(e.right, at, tasks, depth)

      if (e.op === '&&' || e.op === '||') {
        return typeof l === 'boolean' && typeof r === 'boolean' ? (e.op === '&&' ? l && r : l || r) : undefined
      }

      if (typeof l !== 'number' || typeof r !== 'number') {
        return undefined
      }

      switch (e.op) {
        case '+':
          return l + r
        case '-':
          return l - r
        case '*':
          return l * r
        case '/':
          return r !== 0 && l % r === 0 ? l / r : undefined
        case '<':
          return l < r
        case '<=':
          return l <= r
        case '>':
          return l > r
        case '>=':
          return l >= r
        case '==':
          return l === r
        case '!=':
          return l !== r
        default:
          return undefined
      }
    }
    default:
      return undefined
  }
}

// values of `names` where every hypothesis holds and the goal does not, and whether there are any. Small integers
// first, nearest zero first, so the values printed are the plainest ones that show the law false. `natural` names
// start at 0
export function counterexample(
  names: { name: string; natural: boolean }[],
  hypotheses: Expression[],
  goal: Expression,
  // the tasks the rule's statement may call, each run as written
  tasks: Map<string, SmallTask>,
): { found: boolean; at: Map<string, number> } {
  if (names.length === 0 || names.length > 6) {
    return { found: false, at: new Map() }
  }

  const reach = names.length <= 3 ? 4 : names.length === 4 ? 3 : 2
  const range = (natural: boolean): number[] => {
    const out = [0]

    for (let k = 1; k <= reach; k++) {
      out.push(k)

      if (!natural) {
        out.push(-k)
      }
    }

    return out
  }

  const ranges = names.map(n => range(n.natural))
  const at = new Map<string, number>()
  let found: Map<string, number> | undefined

  const search = (i: number): void => {
    if (found) {
      return
    }

    if (i === names.length) {
      if (hypotheses.every(h => evaluate(h, at, tasks) === true) && evaluate(goal, at, tasks) === false) {
        found = new Map(at)
      }

      return
    }

    for (const value of ranges[i]!) {
      at.set(names[i]!.name, value)
      search(i + 1)
    }
  }

  search(0)

  return found ? { found: true, at: found } : { found: false, at: new Map() }
}

// `a = 1, b = 2`
export function printAssignment(at: Map<string, number>): string {
  return [...at].map(([name, value]) => `${name} = ${value}`).join(', ')
}
