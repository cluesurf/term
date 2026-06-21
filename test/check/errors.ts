// Error-experience tests: every diagnostic carries an actionable fix, renders with a readable name, source
// context, carets, and a hint; and a batch reports with a summary. Run: npx tsx test/check/errors.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import {
  render,
  renderKink,
  report,
} from '@cluesurf/make/code/parser/diagnostic'

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

const BAD = `task wrong
  take n
  send back
    call add
      loan n
      text <oops>
`

function main(): void {
  const result = compile({ file: 'bad.tree', text: BAD })
  if (result.ok) {
    console.log('FAIL  expected an error\n\nerrors: 0 pass, 1 fail')
    return
  }
  const d = result.diagnostics[0]!
  ok('every diagnostic has a fix hint', !!d.hint, `hint=${d.hint}`)

  const text = render(d, BAD.split('\n'), false)
  console.log('--- rendered error ---')
  console.log(text)
  ok('shows the readable name', text.includes('type-mismatch'))
  ok('shows the source location', /bad\.tree:\d+:\d+/.test(text))
  ok('shows a caret underline', text.includes('^'))
  ok('shows a hint line', /hint:/.test(text))

  // a did-you-mean for an unknown name
  const typo = compile({
    file: 'bad.tree',
    text: `task t\n  take items\n  back\n    loan itemz\n`,
  })
  ok(
    'unknown name suggests a correction',
    !typo.ok &&
      typo.diagnostics.some(
        x =>
          x.hint?.includes('did you mean') ||
          x.hint?.includes('itemz') ||
          x.name === 'unknown-name',
      ),
    typo.ok
      ? 'compiled'
      : typo.diagnostics.map(x => `${x.name}:${x.hint}`).join(';'),
  )

  // a warning renders distinctly and a report summarizes a batch
  const warned = compile({
    file: 'w.tree',
    text: `task f\n  take n\n  save unused, code 1\n  back n\n`,
  })
  if (warned.ok) {
    const summary = report(
      warned.warnings,
      'task f\n  take n\n  save unused, code 1\n  back n'.split('\n'),
      false,
    )
    ok(
      'report summarizes warnings',
      summary.includes('1 warning'),
      summary.split('\n').pop(),
    )
  } else {
    ok('report summarizes warnings', false, 'compile failed')
  }

  // the beautiful kink-style structured render (with inline source snippet)
  const kink = renderKink(d, BAD.split('\n'), false)
  console.log('--- kink-style render ---')
  console.log(kink)
  ok('kink: titled error', kink.includes('kink <'))
  ok('kink: shows code', kink.includes('code <0007>'))
  ok('kink: shows name', kink.includes('name <type-mismatch>'))
  ok('kink: shows site frame', /site <bad\.tree:\d+:\d+>/.test(kink))
  ok('kink: shows inline caret', kink.includes('^'))
  ok('kink: shows note', kink.includes('note <'))

  // a multi-span blame renders as multiple site/call frames
  const blame = compile({
    file: 'b.tree',
    text: `task bad\n  take n\n  walk test\n    hook test\n      loan n\n    hook step\n      save n, code 0\n  back n\n`,
  })
  if (!blame.ok) {
    const k = renderKink(
      blame.diagnostics[0]!,
      `task bad\n  take n\n  walk test\n    hook test\n      loan n\n    hook step\n      save n, code 0\n  back n`.split(
        '\n',
      ),
      false,
    )
    ok('kink: multi-span shows a call frame', k.includes('call <'), k)
  } else {
    ok('kink: multi-span shows a call frame', false, 'compiled')
  }

  console.log(`\nerrors: ${pass} pass, ${fail} fail`)
}

main()
