// A walk's index is a local of the walk on the kernel's statement-by-statement path too (term-self-host-001-0376).
//
// check/elaborating-commands.tree `check-commands` bound a `walk`'s item and never its index (`take item` / `take at`),
// so a read of the index looked past the walk's scope. With no task of that name the body was declined; with one,
// anywhere in the program, the read became that task, and the build failed with a kernel type mismatch in a module
// that builds clean alone: lint/rule-check-dispatch.tree loading format/milled-meaning.tree failed at
// check/async-resolve.tree's `in-scope` (`get(types, at)`), where compile/minting-reads.tree's `task at` was taken for
// the walk's index. The pure path (elaborating-terms.tree `walk-list-term`) always bound it; a body reaches the
// statement path when the pure lowering stops (here a match with a miss arm). The index is now bound, a number, after
// the item, exactly as the pure path binds it.
//
// Run: npx tsx test/check/walk-index-kernel.ts

import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { resolve } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { elaborateReport } from '@term/make/code/check/elaborate'
import { compile } from '@term/make/code/compile/compile'
import type { Program } from '@term/make/code/compile/node'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf } from '@term/call/code/role-of'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function frontEnd(text: string): Program {
  const parsed = parse({ file: 't.tree', text })

  if (!parsed.ok) {
    throw new Error(`parse failed: ${parsed.diagnostics.map(d => d.message).join('; ')}`)
  }

  const built = mill(expandTemplates(parsed.tree), 't.tree')

  if (!built.ok) {
    throw new Error(`mill failed: ${built.diagnostics.map(d => d.message).join('; ')}`)
  }

  resolve(built.program, 't.tree')
  check(built.program, 't.tree')

  return built.program
}

// a match with a miss arm stops the pure lowering, so the body is checked statement by statement
const LIGHT = `form light\n  case red\n  case green\n\n`
const WALK = (use: string): string =>
  `task total-of\n  take items, like list, like number\n  take l, like light\n  like number\n  save total, code 0\n  walk items\n    take item\n    take at\n    sift l\n      case red\n        ${use}\n      miss\n        save total, add(total, item)\n  send back total\n`
const AT_TASK = `task at\n  take value, like text\n  like text\n  send back, read value\n\n`
const SHOUT = `task shout\n  take value, like text\n  like number\n  send back, code 1\n\n`

const said = (report: ReturnType<typeof elaborateReport>): string =>
  JSON.stringify({ statementwise: report.statementwise, declined: report.declined, diagnostics: report.diagnostics.map(d => d.message) })

const alone = elaborateReport(frontEnd(`${LIGHT}${WALK('save total, add(total, at)')}`), 't.tree')
ok(
  'a walk index read on the statement path is verified',
  alone.verified.includes('total-of') && alone.statementwise.some(s => s.name === 'total-of') && alone.diagnostics.length === 0,
  said(alone),
)

const named = elaborateReport(frontEnd(`${LIGHT}${AT_TASK}${WALK('save total, add(total, at)')}`), 't.tree')
ok(
  'a task named like the index is not reached from inside the walk',
  named.verified.includes('total-of') && named.diagnostics.length === 0,
  said(named),
)

const wrong = elaborateReport(frontEnd(`${LIGHT}${SHOUT}${WALK('save total, add(total, shout(at))')}`), 't.tree')
ok(
  'the index is a number: handing it where a text is taken is the kernel error',
  wrong.diagnostics.some(d => d.message.startsWith('kernel:') && /expected\s+String/.test(d.message) && /found\s+Number/.test(d.message)),
  said(wrong),
)

// the closure that found it: rule-check's async-resolve beside milled-meaning's minting-reads
const root = join(process.cwd(), 'deck/make')
const closure = compile(
  {
    file: join(root, 'code/lint/walk-index-probe.tree'),
    text: `load ./rule-check\n  find check-source\n\nload ../format/milled-meaning\n  find program-of\n`,
  },
  { resolve: projectResolver(root), leanOf: projectLeanOf(root), library: true },
)
ok(
  'lint/rule-check.tree and format/milled-meaning.tree build in one closure',
  closure.ok,
  closure.ok ? '' : closure.diagnostics.filter(d => d.severity !== 'warning').map(d => d.message).join(' | '),
)

console.log(`\nwalk-index-kernel: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
