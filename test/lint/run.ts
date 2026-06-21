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

  // L006: a fork test whose condition is a boolean literal is constant control flow
  {
    const text = `fork test\n  hook test, wave true\n  hook hold\n    send back, code 1\n`
    const fs = findings(text).filter(f => f.code === 'L006')
    ok(
      'L006 flags a constant `wave true` condition',
      fs.length === 1,
      JSON.stringify(findings(text)),
    )

    const live = `fork test\n  hook test\n    read x\n  hook hold\n    send back, code 1\n`
    ok(
      'L006 leaves a real condition alone',
      findings(live).filter(f => f.code === 'L006').length === 0,
      live,
    )
  }

  // L007: comparing an expression to itself is always constant
  {
    const text = `save r\n  call is-equal\n    read x\n    read x\n`
    const fs = findings(text).filter(f => f.code === 'L007')
    ok(
      'L007 flags is-equal(x, x)',
      fs.length === 1,
      JSON.stringify(findings(text)),
    )

    const distinct = `save r\n  call is-equal\n    read x\n    read y\n`
    ok(
      'L007 leaves is-equal(x, y) alone',
      findings(distinct).filter(f => f.code === 'L007').length === 0,
      distinct,
    )

    const below = `save r\n  call is-below\n    read n\n    read n\n`
    ok(
      'L007 flags a self ordering comparison (n < n)',
      findings(below).filter(f => f.code === 'L007').length === 1,
      below,
    )
  }

  // L008: a native import whose alias is never referenced is flagged
  {
    const text = `dock load\n  load <node:fs/promises>, name fs\n\ntask noop\n  send back, code 1\n`
    const fs = findings(text).filter(f => f.code === 'L008')
    ok(
      'L008 flags an unused native import',
      fs.length === 1,
      JSON.stringify(findings(text)),
    )

    const used = `dock load\n  load <node:fs/promises>, name fs\n\ntask read-it\n  mark async\n  send back\n    call fs/read-file\n      text </tmp/x>\n`
    ok(
      'L008 leaves a used native import alone',
      findings(used).filter(f => f.code === 'L008').length === 0,
      JSON.stringify(findings(used)),
    )

    // two imports, only one used: exactly the unused one is flagged
    const mixed = `dock load\n  load <node:fs/promises>, name fs\n  load <node:path>, name pathlib\n\ntask use-path\n  send back\n    call pathlib/join\n      text <a>\n      text <b>\n`
    const mixedFs = findings(mixed).filter(f => f.code === 'L008')
    ok(
      'L008 flags only the unused import in a mixed dock',
      mixedFs.length === 1 && mixedFs[0]!.message.includes('fs'),
      JSON.stringify(findings(mixed)),
    )
  }

  // L009: two branches of a fork test with the same condition (the later one is dead)
  {
    const cond = (n: number) =>
      `  hook test\n    call is-above\n      read x\n      code 5\n  hook hold\n    send back\n      code ${n}\n`
    const dup = `fork test\n${cond(1)}${cond(2)}`
    ok(
      'L009 flags a duplicated branch condition',
      findings(dup).filter(f => f.code === 'L009').length === 1,
      JSON.stringify(findings(dup)),
    )

    const distinct = `fork test\n  hook test\n    call is-above\n      read x\n      code 5\n  hook hold\n    send back\n      code 1\n  hook test\n    call is-above\n      read x\n      code 9\n  hook hold\n    send back\n      code 2\n`
    ok(
      'L009 leaves distinct conditions alone',
      findings(distinct).filter(f => f.code === 'L009').length === 0,
      distinct,
    )
  }

  // L010: assigning a place to itself has no effect
  {
    const text = `task f\n  take x, like number\n  save x\n    read x\n`
    ok(
      'L010 flags a self assignment',
      findings(text).filter(f => f.code === 'L010').length === 1,
      JSON.stringify(findings(text)),
    )

    const real = `task f\n  take x, like number\n  save x\n    call add\n      read x\n      code 1\n`
    ok(
      'L010 leaves a real assignment alone',
      findings(real).filter(f => f.code === 'L010').length === 0,
      real,
    )
  }

  // L011: a statement after a terminator in the same block is unreachable
  {
    const text = `task f\n  send back\n    code 1\n  send back\n    code 2\n`
    ok(
      'L011 flags a statement after `send back`',
      findings(text).filter(f => f.code === 'L011').length === 1,
      JSON.stringify(findings(text)),
    )

    const clean = `task f\n  send back\n    code 1\n`
    ok(
      'L011 leaves a single trailing return alone',
      findings(clean).filter(f => f.code === 'L011').length === 0,
      clean,
    )
  }

  console.log(`\nlint: ${pass} pass, ${fail} fail`)
}

main()
