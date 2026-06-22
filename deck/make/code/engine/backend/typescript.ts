// The TypeScript backend: compile the vibe AST to idiomatic TypeScript. The reference codegen. Emitted programs
// use native JS control flow and functions (so they read like hand-written code, and async / await are native),
// and call the RT runtime (runtime.ts) for the ternary / aggregate ops, so results match the interpreter exactly.
// See note/research/vibe/computation/backend/03-backends.md.

import type {
  Program,
  Statement,
  Expression,
  BinaryOp,
} from '@cluesurf/make/code/engine/ast'
import type { Value } from '@cluesurf/make/code/engine/value'
import * as RT from '@cluesurf/make/code/engine/backend/runtime'
import { exhausted } from '@cluesurf/make/code/compile/backend'

const BINOP: Record<string, string> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'mod',
  '==': 'eq',
  '!=': 'ne',
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
}

// the preamble that binds the built-ins to plain names (so `print(x)` is a direct call in the emitted body)
const PREAMBLE =
  'const print = RT.print, len = RT.len, push = RT.push, keys = RT.keys, str = RT.strOf, int = RT.toInt;'

type Frame = { kind: 'loop' | 'switch'; label: string }

function makeEmitter() {
  let counter = 0

  const stack: Frame[] = []
  const label = (kind: 'loop' | 'switch'): string =>
    `${kind === 'loop' ? 'L' : 'S'}${counter++}`

  const nearest = (kinds: ('loop' | 'switch')[]): string => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (kinds.includes(stack[i]!.kind)) {
        return stack[i]!.label
      }
    }

    throw new Error(
      `no enclosing ${kinds.join('/')} for break/continue`,
    )
  }

  const expr = (e: Expression): string => {
    switch (e.form) {
      case 'integer':
        return `RT.int(${BigInt(e.value)}n)`
      case 'float':
        return `RT.flt(${e.value})`
      case 'boolean':
        return `RT.bool(${e.value})`
      case 'string':
        return `RT.str(${JSON.stringify(e.value)})`
      case 'unit':
        return 'RT.UNIT_V'
      case 'variable':
        return e.name
      case 'array':
        return `RT.array([${e.items.map(expr).join(', ')}])`
      case 'map':
        return `RT.mapLit([${e.entries
          .map(p => `[${JSON.stringify(p.key)}, ${expr(p.value)}]`)
          .join(', ')}])`
      case 'closure':
        return `${e.isAsync ? 'async ' : ''}(${e.params.join(
          ', ',
        )}) => { ${e.body.map(stmt).join(' ')} }`
      case 'unary':
        return e.op === '!'
          ? `RT.notTruthy(${expr(e.operand)})`
          : `RT.neg(${expr(e.operand)})`
      case 'binary':
        if (e.op === '&&') {
          return `RT.and(${expr(e.left)}, () => ${expr(e.right)})`
        }

        if (e.op === '||') {
          return `RT.or(${expr(e.left)}, () => ${expr(e.right)})`
        }

        return `RT.${BINOP[e.op]}(${expr(e.left)}, ${expr(e.right)})`
      case 'call':
        return `${expr(e.callee)}(${e.args.map(expr).join(', ')})`
      case 'await':
        return `(await ${expr(e.expr)})`
      case 'index':
        return `RT.index(${expr(e.target)}, ${expr(e.index)})`
      case 'member':
        return `RT.member(${expr(e.target)}, ${JSON.stringify(e.name)})`
      default:
        return exhausted(e)
    }
  }

  const assignTarget = (
    t: Expression,
    op: string,
    value: Expression,
  ): string => {
    const rhs = expr(value)
    const compound = (current: string): string =>
      op === '=' ? rhs : `RT.${BINOP[op[0]!]}(${current}, ${rhs})`

    if (t.form === 'variable') {
      return `${t.name} = ${compound(t.name)};`
    }

    if (t.form === 'index') {
      if (t.target.form !== 'variable') {
        throw new Error('index assignment target must be a variable')
      }

      const c = t.target.name,
        i = expr(t.index)

      return `${c} = RT.setIndex(${c}, ${i}, ${compound(
        `RT.index(${c}, ${i})`,
      )});`
    }

    if (t.form === 'member') {
      if (t.target.form !== 'variable') {
        throw new Error('member assignment target must be a variable')
      }

      const c = t.target.name,
        n = JSON.stringify(t.name)

      return `${c} = RT.setMember(${c}, ${n}, ${compound(
        `RT.member(${c}, ${n})`,
      )});`
    }

    throw new Error('invalid assignment target')
  }

  const block = (body: Statement[]): string =>
    `{ ${body.map(stmt).join(' ')} }`

  const stmt = (s: Statement): string => {
    switch (s.form) {
      case 'let':
        return `${s.mutable ? 'let' : 'const'} ${s.name} = ${expr(
          s.init,
        )};`
      case 'assign':
        return assignTarget(s.target, s.op, s.value)
      case 'expression':
        return `${expr(s.expr)};`
      case 'return':
        return `return ${s.value ? expr(s.value) : 'RT.UNIT_V'};`
      case 'block':
        return block(s.body)
      case 'function':
        return `${s.isAsync ? 'async ' : ''}function ${
          s.name
        }(${s.params.join(', ')}) ${block(s.body)}`
      case 'break':
        return `break ${nearest(['loop', 'switch'])};`
      case 'continue':
        return `continue ${nearest(['loop'])};`

      case 'if': {
        const head = s.branches
          .map(
            (b, i) =>
              `${i ? ' else ' : ''}if (RT.truthy(${expr(
                b.cond,
              )})) ${block(b.body)}`,
          )
          .join('')

        return s.otherwise ? `${head} else ${block(s.otherwise)}` : head
      }

      case 'while': {
        const lbl = label('loop')
        stack.push({ kind: 'loop', label: lbl })

        const out = `${lbl}: while (RT.truthy(${expr(s.cond)})) ${block(
          s.body,
        )}`

        stack.pop()

        return out
      }

      case 'switch': {
        const lbl = label('switch')
        stack.push({ kind: 'switch', label: lbl })

        const subj = `_s${counter}`,
          matched = `_m${counter}`

        counter++

        let out = `${lbl}: { const ${subj} = ${expr(
          s.subject,
        )}; let ${matched} = false; `

        for (const c of s.cases) {
          out += `if (${matched} || RT.truthy(RT.eq(${subj}, ${expr(
            c.match,
          )}))) { ${matched} = true; ${c.body.map(stmt).join(' ')} } `
        }

        if (s.otherwise) {
          out += `if (!${matched}) { ${s.otherwise
            .map(stmt)
            .join(' ')} } `
        }

        out += '}'
        stack.pop()

        return out
      }

      case 'throw':
        return `throw RT.toError(${expr(s.value)});`

      case 'try': {
        let out = `try ${block(s.body)}`

        if (s.catchBody) {
          // the JS catch param is internal; the optional user-named binding recovers the original thrown Value
          const raw = `_err${counter++}`
          const bind = s.catchName
            ? `const ${s.catchName} = RT.fromError(${raw}); `
            : ''

          out += ` catch (${raw}) { ${bind}${s.catchBody
            .map(stmt)
            .join(' ')} }`
        }

        if (s.finallyBody) {
          out += ` finally ${block(s.finallyBody)}`
        }

        return out
      }

      case 'for': {
        const lbl = label('loop')
        stack.push({ kind: 'loop', label: lbl })

        const out = `${lbl}: for (const ${s.name} of RT.iterate(${expr(
          s.iterable,
        )})) ${block(s.body)}`

        stack.pop()

        return out
      }

      default:
        return exhausted(s)
    }
  }

  return { expr, stmt }
}

// the emitted module text (importing the runtime), the standalone TypeScript output
export function compileToTypeScript(program: Program): string {
  const e = makeEmitter()
  const lines = [
    "import * as RT from '@cluesurf/make/code/engine/backend/runtime'",
    PREAMBLE,
    ...program.map(e.stmt),
  ]

  return lines.join('\n')
}

// run a compiled program in-process for validation (returns the last expression's value)
export async function runCompiled(program: Program): Promise<Value> {
  const e = makeEmitter()
  const decls = program
    .filter(s => s.form === 'function')
    .map(e.stmt)
    .join('\n')

  const top = program.filter(s => s.form !== 'function')
  const body = top
    .map((s, i) =>
      i === top.length - 1 && s.form === 'expression'
        ? `return ${e.expr(s.expr)};`
        : e.stmt(s),
    )
    .join('\n')

  const fn = new Function(
    'RT',
    `return (async () => { ${PREAMBLE} ${decls} ${body} return RT.UNIT_V; })()`,
  )

  return fn(RT) as Promise<Value>
}

// run a named function from a compiled program with argument values, for validation against the interpreter
export async function runCompiledFunction(
  program: Program,
  name: string,
  args: Value[],
): Promise<Value> {
  const e = makeEmitter()
  const decls = program
    .filter(s => s.form === 'function')
    .map(e.stmt)
    .join('\n')

  const fn = new Function(
    'RT',
    '__ARGS__',
    `return (async () => { ${PREAMBLE} ${decls} return ${name}(...__ARGS__); })()`,
  )

  return fn(RT, args) as Promise<Value>
}
