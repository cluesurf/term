// A NEGATED ORDERING IS NOT THE OPPOSITE ORDERING WHEN AN OPERAND MAY BE NaN (term-compiler-0059). The simplifier
// (ir/simplifying.tree, the `not` case) turned `not(is-minimum(x, 1))` into `x < 1`, but NaN compares false every way:
// `not(NaN >= 1)` is true and `NaN < 1` is false. It compiled clean and read NaN as a count (deck/test/code/
// concurrency.tree, cli-in-term traps.md). An ordering is flipped only when neither operand can be NaN: an integer
// literal or a number with a width. `is-equal` / `is-unequal` flip always, NaN being unequal to everything.
// Each case is built AND run on every backend. Run from deck/term/deck/term: npx tsx test/compile/negated-compare.ts
// (NEGATED_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { BACKENDS, runOn } from './shared/run-on'

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

// a float NaN, made at run time so no fold sees it, against each negated ordering; then a plain float, which each
// negation must still answer as the opposite ordering does
const PROGRAM = `load @term/base/float
  find square-root

task nan-of
  take x, like float
  like float

  back square-root(x)

task run
  like text

  save x, nan-of(-1.0)
  save a, not(is-minimum(x, 1.0))
  save b, not(is-above(x, 1.0))
  save c, not(is-below(x, 1.0))
  save d, not(is-maximum(x, 1.0))
  save y, nan-of(4.0)
  save e, not(is-minimum(y, 1.0))
  save f, not(is-below(y, 1.0))
  back <{a} {b} {c} {d} {e} {f}>
`

const EXPECTED = 'true true true true false true'

const dir = mkdtempSync(join(tmpdir(), 'term-negated-compare-'))
const only = process.env.NEGATED_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'negated',
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a negated ordering over NaN is true, over 2 the opposite ordering`,
    ran.form === 'ran' && ran.output.trim() === EXPECTED,
    ran.form === 'ran'
      ? `got ${ran.output.trim()}`
      : `${ran.stage}: ${ran.reason}`,
  )
}

// a host number may be NaN on TypeScript: the trap's own shape, a count read through a bind
if (!only || only === 'typescript') {
  const text = `bind host-count
  like number
  case node
    text <Number("x")>

task run
  like boolean

  save count, host-count()
  back not(is-minimum(count, 1))
`
  const built = compile({ file: join(dir, 'host.tree'), text }, {
    leanOf: () => true,
  } as never)

  if (!built.ok) {
    ok(
      'typescript: a host NaN count builds',
      false,
      built.diagnostics.map(d => d.message).join(' | '),
    )
  } else {
    const file = join(dir, 'host.mjs')
    writeFileSync(
      file,
      transformSync(built.typescript, { loader: 'ts', format: 'esm' })
        .code,
    )
    const answer = await (
      (await import(pathToFileURL(file).href)) as { run: () => unknown }
    ).run()
    ok(
      'typescript: not(is-minimum(count, 1)) over a host NaN is true',
      answer === true,
      `got ${String(answer)}: ${built.typescript
        .split('\n')
        .filter(l => /count/.test(l))
        .join(' / ')}`,
    )
  }

  // an integer literal against a number with a width cannot be NaN, so that one still flips
  const widthText = `task run
  take b, like u8
  like boolean

  back not(is-minimum(b, 1))
`
  const width = compile(
    { file: join(dir, 'width.tree'), text: widthText },
    { leanOf: () => true } as never,
  )

  ok(
    'typescript: a u8 against 1 still flips to b < 1',
    width.ok && /b < 1/.test(width.typescript),
    width.ok
      ? width.typescript
          .split('\n')
          .filter(l => /return/.test(l))
          .join(' / ')
      : width.diagnostics.map(d => d.message).join(' | '),
  )
}

console.log(`\nnegated-compare: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
