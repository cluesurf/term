// String/ANSI render target tests: the reactive graph drives a terminal view, updating minimally on change.
// Run: npx tsx test/zone/terminal.ts

import { signal } from '@cluesurf/make/code/zone/reactive'
import {
  ansi,
  group,
  render,
  still,
  text,
} from '@cluesurf/make/code/zone/terminal'

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

function main(): void {
  // a reactive terminal view that re-renders on signal change
  const [count, setCount] = signal(0)
  const view = group([still('Count: '), text(() => String(count()))])

  expect('initial render', render(view), 'Count: 0')
  setCount(5)
  expect('render after change', render(view), 'Count: 5')
  setCount(42)
  expect('render after another change', render(view), 'Count: 42')

  // minimal update: the reactive cell recomputes only when its signal changes
  const [name, setName] = signal('ann')
  let recomputes = 0
  const reactiveCell = text(() => {
    recomputes++
    return name()
  })
  expect('cell computed once', recomputes, 1)
  const staticView = group([reactiveCell, still('!')])
  render(staticView)
  render(staticView)
  expect('render does not recompute', recomputes, 1) // render reads cached values
  setName('bob')
  expect('recomputes only on change', recomputes, 2)
  expect('updated render', render(staticView), 'bob!')

  // ANSI styling
  const styled = text(() => 'error', ansi.red)
  expect('ansi red applied', render(styled), '\x1b[31merror\x1b[0m')

  console.log(`\nterminal: ${pass} pass, ${fail} fail`)
}

main()
