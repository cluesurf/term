// The control-flow graph: a function body lowered to basic blocks and the edges between them. Straight-line runs
// of statements become one block; `if` / `while` / `for-each` / `match` / `return` / `break` / `continue` become
// the terminators that wire blocks together. This is the structural backbone the later passes (Perceus control
// flow, register/stack allocation, native lowering) walk. See note/research/vibe/computation/plans/05-ir.md.
// Pure and browser-safe.

import type {
  Expression,
  Statement,
} from '@term/make/code/compile/node'

export type Terminator =
  | { kind: 'return' } // leaves the function
  | { kind: 'jump'; target: number } // unconditional edge
  | {
      kind: 'branch'
      condition: Expression
      whenTrue: number
      whenFalse: number
    } // if / while header
  | {
      kind: 'loop'
      item: string
      iterable: Expression
      body: number
      after: number
    } // for-each header
  | {
      kind: 'switch'
      subject: Expression
      cases: { label: string; target: number }[]
      otherwise: number
    } // match

export type Block = {
  id: number
  body: Statement[]
  terminator: Terminator
}
export type Cfg = { entry: number; blocks: Block[] }

type Loop = { breakTo: number; continueTo: number }

const CONTROL = new Set([
  'if',
  'while',
  'for-each',
  'match',
  'return',
  'break',
  'continue',
])

const isControl = (statement: Statement): boolean =>
  CONTROL.has(statement.form)

export function buildCfg(body: Statement[]): Cfg {
  const blocks: Block[] = []

  const create = (): Block => {
    const block: Block = {
      id: blocks.length,
      body: [],
      terminator: { kind: 'return' },
    }

    blocks.push(block)

    return block
  }

  // build a statement sequence; on normal completion control flows to `next`. Returns the entry block id.
  function sequence(
    statements: Statement[],
    next: number,
    loop: Loop | undefined,
  ): number {
    if (statements.length === 0) {
      return next
    }

    let split = 0

    while (
      split < statements.length &&
      !isControl(statements[split]!)
    ) {
      split++
    }

    if (split === statements.length) {
      // an all-straight-line run: one block that jumps onward
      const block = create()
      block.body = statements.slice()
      block.terminator = { kind: 'jump', target: next }

      return block.id
    }

    const prefix = statements.slice(0, split)
    const restEntry = sequence(statements.slice(split + 1), next, loop)
    const controlEntry = control(statements[split]!, restEntry, loop)

    if (prefix.length === 0) {
      return controlEntry
    }

    const block = create()
    block.body = prefix
    block.terminator = { kind: 'jump', target: controlEntry }

    return block.id
  }

  // build a single control-flow statement; returns its entry block id
  function control(
    statement: Statement,
    next: number,
    loop: Loop | undefined,
  ): number {
    switch (statement.form) {
      case 'return': {
        const block = create()
        block.body = [statement]
        block.terminator = { kind: 'return' }

        return block.id
      }

      case 'break': {
        const block = create()
        block.terminator = {
          kind: 'jump',
          target: loop ? loop.breakTo : next,
        }

        return block.id
      }

      case 'continue': {
        const block = create()
        block.terminator = {
          kind: 'jump',
          target: loop ? loop.continueTo : next,
        }

        return block.id
      }

      case 'if': {
        // build the else side, then chain each branch's condition in front of it
        let chain = statement.otherwise
          ? sequence(statement.otherwise, next, loop)
          : next

        for (let i = statement.branches.length - 1; i >= 0; i--) {
          const branch = statement.branches[i]!
          const whenTrue = sequence(branch.body, next, loop)
          const header = create()
          header.terminator = {
            kind: 'branch',
            condition: branch.cond,
            whenTrue,
            whenFalse: chain,
          }
          chain = header.id
        }

        return chain
      }

      case 'while': {
        const header = create()
        const bodyEntry = sequence(statement.body, header.id, {
          breakTo: next,
          continueTo: header.id,
        })

        header.terminator = {
          kind: 'branch',
          condition: statement.cond,
          whenTrue: bodyEntry,
          whenFalse: next,
        }

        return header.id
      }

      case 'for-each': {
        const header = create()
        const bodyEntry = sequence(statement.body, header.id, {
          breakTo: next,
          continueTo: header.id,
        })

        header.terminator = {
          kind: 'loop',
          item: statement.item,
          iterable: statement.iterable,
          body: bodyEntry,
          after: next,
        }

        return header.id
      }

      case 'match': {
        const cases = statement.cases.map(branch => ({
          label: branch.label,
          target: sequence(branch.body, next, loop),
        }))

        const otherwise = statement.otherwise
          ? sequence(statement.otherwise, next, loop)
          : next

        const block = create()
        block.terminator = {
          kind: 'switch',
          subject: statement.subject,
          cases,
          otherwise,
        }

        return block.id
      }

      default: {
        const block = create()
        block.body = [statement]
        block.terminator = { kind: 'jump', target: next }

        return block.id
      }
    }
  }

  // a synthetic exit block (id 0) that every `return` and fall-through reaches
  const exit = create()
  exit.terminator = { kind: 'return' }

  const entry = sequence(body, exit.id, undefined)

  return { entry, blocks }
}

// the successor block ids of a terminator (for graph walks)
export function successors(terminator: Terminator): number[] {
  switch (terminator.kind) {
    case 'return':
      return []
    case 'jump':
      return [terminator.target]
    case 'branch':
      return [terminator.whenTrue, terminator.whenFalse]
    case 'loop':
      return [terminator.body, terminator.after]
    case 'switch':
      return [
        ...terminator.cases.map(c => c.target),
        terminator.otherwise,
      ]
  }
}
