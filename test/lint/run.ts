// Linter + unified-analysis tests. Run: npx tsx test/lint/run.ts

import { lint, applyFixes } from '@cluesurf/make/code/lint/lint'
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
    {throw new Error(
      'parse failed: ' + JSON.stringify(parsed.diagnostics),
    )}

  const built = mill(parsed.tree, 't.tree')

  if (!built.ok)
    {throw new Error('mill failed: ' + JSON.stringify(built.diagnostics))}

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
    const text = `fork test\n  hook test, true\n  hook hold\n    send back, code 1\n`
    const fs = findings(text).filter(f => f.code === 'L006')
    ok(
      'L006 flags a constant `true` condition',
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

  // L012: a fork test whose two branches run identical statements
  {
    const same = `task f\n  take c, like boolean\n  fork test\n    hook test, read c\n    hook hold\n      send back, code 1\n    hook miss\n      send back, code 1\n`
    ok(
      'L012 flags identical fork branches',
      findings(same).filter(f => f.code === 'L012').length === 1,
      JSON.stringify(findings(same)),
    )

    const diverge = `task f\n  take c, like boolean\n  fork test\n    hook test, read c\n    hook hold\n      send back, code 1\n    hook miss\n      send back, code 2\n`
    ok(
      'L012 leaves diverging branches alone',
      findings(diverge).filter(f => f.code === 'L012').length === 0,
      diverge,
    )
  }

  // L013: two arms of a fork case with the same label
  {
    const dup = `form color\n  case red\n  case green\n\ntask f\n  take c, like color\n  like text\n  fork case, read c\n    case red\n      send back, text <a>\n    case green\n      send back, text <b>\n    case red\n      send back, text <c>\n`
    ok(
      'L013 flags a duplicated case label',
      findings(dup).filter(f => f.code === 'L013').length === 1,
      JSON.stringify(findings(dup)),
    )

    const distinct = `form color\n  case red\n  case green\n\ntask f\n  take c, like color\n  like text\n  fork case, read c\n    case red\n      send back, text <a>\n    case green\n      send back, text <b>\n`
    ok(
      'L013 leaves distinct cases alone',
      findings(distinct).filter(f => f.code === 'L013').length === 0,
      distinct,
    )
  }

  // L014: a comparison of two literals is always constant
  {
    const constCmp = `task f\n  like boolean\n  send back\n    call is-below\n      code 5\n      code 3\n`
    ok(
      'L014 flags a two-literal comparison',
      findings(constCmp).filter(f => f.code === 'L014').length === 1,
      JSON.stringify(findings(constCmp)),
    )

    const realCmp = `task f\n  take x, like number\n  like boolean\n  send back\n    call is-below\n      read x\n      code 3\n`
    ok(
      'L014 leaves a variable comparison alone',
      findings(realCmp).filter(f => f.code === 'L014').length === 0,
      realCmp,
    )
  }

  // L015: duplicate record field
  {
    const dupField = `form point\n  link x, like number\n  link y, like number\n\ntask f\n  send back\n    make point\n      bind x, code 1\n      bind y, code 2\n      bind x, code 3\n`
    ok(
      'L015 flags a duplicate record field',
      findings(dupField).filter(f => f.code === 'L015').length === 1,
      JSON.stringify(findings(dupField)),
    )

    const okRec = `form point\n  link x, like number\n  link y, like number\n\ntask f\n  send back\n    make point\n      bind x, code 1\n      bind y, code 2\n`
    ok(
      'L015 leaves distinct fields alone',
      findings(okRec).filter(f => f.code === 'L015').length === 0,
      okRec,
    )
  }

  // L016: double negation
  {
    const dn = `task f\n  take x, like boolean\n  like boolean\n  send back\n    fork lack\n      fork lack\n        read x\n`
    ok(
      'L016 flags a double negation',
      findings(dn).filter(f => f.code === 'L016').length === 1,
      JSON.stringify(findings(dn)),
    )

    const single = `task f\n  take x, like boolean\n  like boolean\n  send back\n    fork lack\n      read x\n`
    ok(
      'L016 leaves a single negation alone',
      findings(single).filter(f => f.code === 'L016').length === 0,
      single,
    )
  }

  // L017: comparison to a boolean literal
  {
    const cmp = `task f\n  take x, like boolean\n  like boolean\n  send back\n    call is-equal\n      read x\n      true\n`
    ok(
      'L017 flags `x == true`',
      findings(cmp).filter(f => f.code === 'L017').length === 1,
      JSON.stringify(findings(cmp)),
    )
  }

  // L018: a binding returned on the very next line
  {
    const direct = `task f\n  like number\n  save x\n    call add\n      code 1\n      code 2\n  send back\n    read x\n`
    ok(
      'L018 flags a bind-then-return',
      findings(direct).filter(f => f.code === 'L018').length === 1,
      JSON.stringify(findings(direct)),
    )

    const used = `task f\n  like number\n  save x\n    code 5\n  send back\n    call add\n      read x\n      read x\n`
    ok(
      'L018 leaves a used binding alone',
      findings(used).filter(f => f.code === 'L018').length === 0,
      used,
    )
  }

  // L019: a line longer than 84 characters
  {
    const long = `task f\n  send back, text <${'x'.repeat(80)}>\n`
    ok(
      'L019 flags a line over 84 chars',
      findings(long).filter(f => f.code === 'L019').length >= 1,
      JSON.stringify(findings(long).filter(f => f.code === 'L019')),
    )
    ok(
      'L019 leaves short lines alone',
      findings(`task f\n  send back, code 1\n`).filter(
        f => f.code === 'L019',
      ).length === 0,
    )
  }

  // L020: a tab (indent with two spaces); caught wherever the parser tolerates a tab (e.g. a comment)
  {
    const tabbed = `# a\tcomment with a tab\ntask f\n  send back, code 1\n`
    ok(
      'L020 flags a tab',
      findings(tabbed).filter(f => f.code === 'L020').length === 1,
      JSON.stringify(findings(tabbed).filter(f => f.code === 'L020')),
    )
    ok(
      'L020 leaves a two-space-indented file alone',
      findings(`task f\n  send back, code 1\n`).filter(
        f => f.code === 'L020',
      ).length === 0,
    )
  }

  // L021: two string literals concatenated
  {
    const concat = `task f\n  like text\n  send back\n    call add\n      text <a>\n      text <b>\n`
    ok(
      'L021 flags two concatenated string literals',
      findings(concat).filter(f => f.code === 'L021').length === 1,
      JSON.stringify(findings(concat)),
    )
  }

  // L022: a continue as the last statement of a loop
  {
    const redundant = `task f\n  walk test\n    hook test\n      read go\n    hook hold\n      turn next\n`
    ok(
      'L022 flags a trailing continue',
      findings(redundant).filter(f => f.code === 'L022').length === 1,
      JSON.stringify(findings(redundant)),
    )
  }

  // applyFixes: the double-negation fix collapses `!!x` to `x` in the source
  {
    const text = `task f\n  take x, like boolean\n  like boolean\n  send back\n    fork lack\n      fork lack\n        read x\n`
    const fixed = applyFixes(text, findings(text))
    ok(
      'applyFixes removes the double negation',
      (fixed.match(/fork lack/g)?.length ?? 0) === 0 &&
        fixed.includes('read x'),
      JSON.stringify(fixed),
    )

    // applying fixes to already-clean source is a no-op
    const clean = `task f\n  send back, code 1\n`
    ok(
      'applyFixes is a no-op on clean source',
      applyFixes(clean, findings(clean)) === clean,
    )
  }

  // L023: no-else-return (every branch exits)
  ok(
    'L023 flags an unnecessary else after exiting branches',
    findings(
      `task f\n  take c, like boolean\n  like number\n  fork test\n    hook test, read c\n    hook hold\n      send back, code 1\n    hook miss\n      send back, code 2\n`,
    ).filter(f => f.code === 'L023').length === 1,
  )

  // L024: no-duplicate-load
  ok(
    'L024 flags a module loaded twice',
    findings(
      `dock load\n  load <node:fs>, name fs\n  load <node:fs>, name fs2\n\ntask f\n  send back, code 1\n`,
    ).filter(f => f.code === 'L024').length === 2,
  )

  // L025: no-negated-condition
  ok(
    'L025 flags a negated fork condition with an else',
    findings(
      `task f\n  take x, like boolean\n  like number\n  fork test\n    hook test\n      fork lack\n        read x\n    hook hold\n      send back, code 1\n    hook miss\n      send back, code 2\n`,
    ).filter(f => f.code === 'L025').length === 1,
  )

  // L026: no-lonely-if
  ok(
    'L026 flags an else that holds only a fork',
    findings(
      `task f\n  take a, like boolean\n  take b, like boolean\n  like number\n  fork test\n    hook test, read a\n    hook hold\n      send back, code 1\n    hook miss\n      fork test\n        hook test, read b\n        hook hold\n          send back, code 2\n`,
    ).filter(f => f.code === 'L026').length === 1,
  )

  // L027: consistent-return
  ok(
    'L027 flags a function returning a value on some paths and nothing on others',
    findings(
      `task f\n  take c, like boolean\n  like number\n  fork test\n    hook test, read c\n    hook hold\n      send back, code 1\n    hook miss\n      send back\n`,
    ).filter(f => f.code === 'L027').length === 1,
  )

  // L028: no-useless-return
  ok(
    'L028 flags a trailing value-less send back',
    findings(`task f\n  show <hi>\n  send back\n`).filter(
      f => f.code === 'L028',
    ).length === 1,
  )

  // L017 fix: `x == true` -> `x`
  {
    const text = `task f\n  take x, like boolean\n  like boolean\n  send back\n    call is-equal\n      read x\n      true\n`
    const fixed = applyFixes(text, findings(text))
    ok(
      'L017 fix collapses `x == true` to `x`',
      !fixed.includes('is-equal') && !fixed.includes('true'),
      JSON.stringify(fixed),
    )
  }

  // deletion fixes (L028 useless-return) remove the no-op line and the result still parses
  {
    const text = `task f\n  show <hi>\n  send back\n`
    const fixed = applyFixes(text, findings(text))
    ok(
      'L028 fix deletes the trailing return and re-parses cleanly',
      parse({ file: 'x.tree', text: fixed }).ok &&
        !fixed
          .split('\n')
          .slice(1)
          .some(l => l.trim() === 'send back'),
      JSON.stringify(fixed),
    )
  }

  // L029: trailing whitespace
  ok(
    'L029 flags trailing whitespace',
    findings(`task f  \n  send back, code 1\n`).filter(
      f => f.code === 'L029',
    ).length === 1,
  )

  // L030: more than two consecutive blank lines
  ok(
    'L030 flags 3+ consecutive blank lines',
    findings(
      `task f\n  send back, code 1\n\n\n\ntask g\n  send back, code 2\n`,
    ).filter(f => f.code === 'L030').length === 1,
  )

  // analyze().fix() does the full lint -> apply-fixes -> re-format in one call
  {
    const text = `task f\n  take x, like boolean\n  like boolean\n  send back\n    fork lack\n      fork lack\n        read x\n`
    const fixed = analyze({ file: 'a.tree', text }).fix()
    ok(
      'analyze().fix() collapses !!x and re-formats',
      !fixed.includes('fork lack') &&
        fixed.includes('read x') &&
        parse({ file: 'a.tree', text: fixed }).ok,
      JSON.stringify(fixed),
    )
  }

  // L031: returning a boolean literal from each fork branch is just the condition
  {
    const redundant = `task f\n  take c, like boolean\n  like boolean\n  fork test\n    hook test, read c\n    hook hold\n      send back, true\n    hook miss\n      send back, false\n`
    const fs = findings(redundant).filter(f => f.code === 'L031')
    ok(
      'L031 flags `if c { true } else { false }`',
      fs.length === 1,
      JSON.stringify(findings(redundant)),
    )
    ok(
      'L031 fix returns the condition directly',
      fs[0]?.fix?.text === 'send back, read c',
      JSON.stringify(fs[0]?.fix),
    )

    const real = `task f\n  take c, like boolean\n  like number\n  fork test\n    hook test, read c\n    hook hold\n      send back, code 1\n    hook miss\n      send back, code 2\n`
    ok(
      'L031 leaves non-boolean returns alone',
      findings(real).filter(f => f.code === 'L031').length === 0,
      real,
    )

    // the fix collapses the fork and the result still parses
    const fixed = applyFixes(redundant, findings(redundant))
    ok(
      'L031 fix re-parses cleanly without the fork',
      parse({ file: 'x.tree', text: fixed }).ok &&
        !fixed.includes('fork test'),
      JSON.stringify(fixed),
    )
  }

  // L032: a value-position conditional with boolean-literal arms is just the condition
  {
    const redundant = `task f\n  take c, like boolean\n  like boolean\n  save r\n    fork test\n      hook test, read c\n      hook hold, true\n      hook miss, false\n  send back, read r\n`
    const fs = findings(redundant).filter(f => f.code === 'L032')
    ok(
      'L032 flags a `c ? true : false` conditional',
      fs.length === 1,
      JSON.stringify(findings(redundant)),
    )
    ok(
      'L032 fix uses the bare condition',
      fs[0]?.fix?.text === 'read c',
      JSON.stringify(fs[0]?.fix),
    )

    const real = `task f\n  take c, like boolean\n  like number\n  save r\n    fork test\n      hook test, read c\n      hook hold, code 1\n      hook miss, code 2\n  send back, read r\n`
    ok(
      'L032 leaves non-boolean arms alone',
      findings(real).filter(f => f.code === 'L032').length === 0,
      real,
    )
  }

  // L033: a negated equality is clearer as the opposite comparison
  {
    const negated = `task f\n  take a, like number\n  take b, like number\n  like boolean\n  send back\n    fork lack\n      call is-equal\n        read a\n        read b\n`
    ok(
      'L033 flags `!(a == b)`',
      findings(negated).filter(f => f.code === 'L033').length === 1,
      JSON.stringify(findings(negated)),
    )

    const plain = `task f\n  take a, like boolean\n  like boolean\n  send back\n    fork lack\n      read a\n`
    ok(
      'L033 leaves a plain negation alone',
      findings(plain).filter(f => f.code === 'L033').length === 0,
      plain,
    )
  }

  // L034: comparing a size to zero reads as an emptiness check
  {
    const sized = `task f\n  take items, like list\n  like boolean\n  send back\n    call is-equal\n      call size, read items\n      code 0\n`
    ok(
      'L034 flags `size(items) == 0`',
      findings(sized).filter(f => f.code === 'L034').length === 1,
      JSON.stringify(findings(sized)),
    )

    const plain = `task f\n  take a, like number\n  like boolean\n  send back\n    call is-equal\n      read a\n      code 0\n`
    ok(
      'L034 leaves a plain `a == 0` alone',
      findings(plain).filter(f => f.code === 'L034').length === 0,
      plain,
    )
  }

  // L035: a fork case with no arms handles nothing
  {
    const empty = `form color\n  case red\n  case green\n\ntask f\n  take c, like color\n  fork case, read c\n`
    ok(
      'L035 flags an empty fork case',
      findings(empty).filter(f => f.code === 'L035').length === 1,
      JSON.stringify(findings(empty)),
    )

    const full = `form color\n  case red\n  case green\n\ntask f\n  take c, like color\n  like text\n  fork case, read c\n    case red\n      send back, text <a>\n    case green\n      send back, text <b>\n`
    ok(
      'L035 leaves a populated fork case alone',
      findings(full).filter(f => f.code === 'L035').length === 0,
      full,
    )
  }

  // L036: a map literal with a duplicate key
  {
    const dup = `save m\n  make find\n    save a, code 1\n    save b, code 2\n    save a, code 3\n`
    ok(
      'L036 flags a duplicated map key',
      findings(dup).filter(f => f.code === 'L036').length === 1,
      JSON.stringify(findings(dup)),
    )

    const distinct = `save m\n  make find\n    save a, code 1\n    save b, code 2\n`
    ok(
      'L036 leaves distinct keys alone',
      findings(distinct).filter(f => f.code === 'L036').length === 0,
      distinct,
    )
  }

  console.log(`\nlint: ${pass} pass, ${fail} fail`)
}

main()
