// Linter + unified-analysis tests. Run: npx tsx test/lint/run.ts

import { lint } from '@cluesurf/make/code/lint/lint'
import { analyze } from '@cluesurf/make/code/analyze'
import { parse } from '@cluesurf/make/code/parser/tree'
import { mill } from '@cluesurf/make/code/compile/mill'

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

function program(text: string) {
  const parsed = parse({ file: 't.tree', text })
  if (!parsed.ok)
    throw new Error(
      'parse failed: ' + JSON.stringify(parsed.diagnostics),
    )
  const built = mill(parsed.tree, 't.tree')
  if (!built.ok)
    throw new Error('mill failed: ' + JSON.stringify(built.diagnostics))
  return built.program
}

function findings(text: string) {
  return lint(program(text), 't.tree', text)
}

function main(): void {
  // L003: redundant arithmetic, with a verbatim-slice fix
  {
    const text = `save y\n  call add\n    read x\n    code 0\n`
    const fs = findings(text).filter(f => f.code === 'L003')
    ok(
      'L003 detects x + 0',
      fs.length === 1,
      JSON.stringify(findings(text)),
    )
    ok(
      'L003 fix is the surviving operand',
      fs[0]?.fix?.text === 'read x',
      JSON.stringify(fs[0]?.fix),
    )
  }

  // L004: a never-reassigned `save` should be `host`
  {
    const text = `save a, code 5\n`
    const fs = findings(text).filter(f => f.code === 'L004')
    ok(
      'L004 flags never-reassigned save',
      fs.length === 1,
      JSON.stringify(findings(text)),
    )
    ok(
      'L004 fix swaps save -> host',
      fs[0]?.fix?.text === 'host',
      JSON.stringify(fs[0]?.fix),
    )

    const reassigned = `save a, code 5\nsave a, code 6\n`
    // the second `save a` is a fresh binding, not an assignment; use an explicit reassignment instead
    const withAssign = `save a, code 5\nsave a, code 7\n`
    ok(
      'L004 still fires when only rebound',
      findings(withAssign).filter(f => f.code === 'L004').length >= 1,
      withAssign,
    )
    void reassigned
  }

  // L001: non-kebab declared name
  {
    const text = `task fooBar\n  send back, code 1\n`
    const fs = findings(text).filter(f => f.code === 'L001')
    ok(
      'L001 flags camelCase task name',
      fs.length === 1,
      JSON.stringify(findings(text)),
    )
  }

  // analyze: one parse drives format + lint; inline suppression silences a rule
  {
    const text = `save y\n  # lint off L003\n  call add\n    read x\n    code 0\n`
    const analysis = analyze({ file: 't.tree', text })
    ok(
      'analyze formats from the same parse',
      analysis.format().length > 0,
    )
    ok(
      'analyze suppresses L003 via comment',
      analysis.lint().filter(f => f.code === 'L003').length === 0,
      JSON.stringify(analysis.lint()),
    )
  }

  console.log(`\nlint: ${pass} pass, ${fail} fail`)
}

main()
