// Tailwind JIT + incremental + subscription tests. Covers the styling pipeline added on the Salsa query graph:
// used-class extraction from the milled program, the JIT catalog filter, the backdated `usedClasses` query, and the
// side-effect subscription layer. Run: `npx tsx deck/test/code/demo-jit.ts`. See note/library/face/tailwind-jit.md.

import { parse } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { collectUsedClasses } from '@term/make/code/compile/used-classes'
import { compileLookCss } from '@term/make/code/compile/look-css'
import { QueryCompiler } from '@term/make/code/compile/incremental'
import { Subscriptions } from '@term/make/code/compile/subscribe'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}${info ? '  ' + info : ''}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? '  ' + info : ''}`)
  }
}

// a small inline utility catalog (the look DSL), so the test does not depend on the generated tailwind.tree
const CATALOG = `face flex
  have display, text <flex>
face gap-2
  have gap, text <0.5rem>
face p-4
  have padding, text <1rem>
face bg-zinc-900
  have background-color, text <#18181b>
face md:flex
  case md
    have display, text <flex>
tone
  have accent, text <#8b5cf6>
`

function milledOf(src: string) {
  const parsed = parse({ file: 't.tree', text: src })
  if (!parsed.ok) {
    return undefined
  }
  const m = mill(expandTemplates(parsed.tree), 't.tree')
  return m.ok ? m.program : undefined
}

async function main(): Promise<void> {
  // 1) extraction: literal class tokens off the milled zone elements
  const prog = milledOf(`zone demo
  take host, like view
  zone div
    bind class, text <flex gap-2 p-4 md:flex>
    site`)
  const used = prog
    ? collectUsedClasses(prog)
    : { classes: [], dynamic: false }
  ok(
    'extracts literal class tokens',
    used.classes.join(' ') === 'flex gap-2 md:flex p-4',
    used.classes.join(' '),
  )
  ok('no false dynamic flag on literal classes', used.dynamic === false)

  // 2) dynamic class is flagged (so the build can fall back to the full catalog)
  const dyn = milledOf(`zone demo
  take host, like view
  zone div
    bind class, read theme
    site`)
  ok(
    'flags a dynamic (non-literal) class',
    !!dyn && collectUsedClasses(dyn).dynamic === true,
  )

  // 3) JIT filter: full catalog vs the used subset
  const full = compileLookCss({ file: 'c.tree', text: CATALOG })
  const jit = compileLookCss(
    { file: 'c.tree', text: CATALOG },
    { only: new Set(used.classes) },
  )
  ok('JIT is smaller than the full catalog', jit.length < full.length)
  ok('JIT keeps a used base rule', jit.includes('.flex {'))
  ok('JIT keeps a used variant rule', jit.includes('.md\\:flex'))
  ok(
    'JIT drops an unused rule',
    full.includes('.bg-zinc-900') && !jit.includes('.bg-zinc-900'),
  )
  ok('JIT always keeps the theme tokens', jit.includes('--accent'))

  // 4) incremental usedClasses query backdates across a non-class edit
  const qc = new QueryCompiler()
  const F = ['demo.tree']
  const runUsed = () => qc.db.transaction(cx => qc.usedClasses(cx, F))

  qc.setSource(
    'demo.tree',
    `zone demo
  take host, like view
  zone div
    bind class, text <flex gap-2>
    site`,
  )
  const u1 = (await runUsed()).join(' ')
  qc.setSource(
    'demo.tree',
    `zone demo
  take host, like view
  zone div
    bind class, text <flex gap-2>
    zone span
      site`,
  )
  const u2 = (await runUsed()).join(' ')
  qc.setSource(
    'demo.tree',
    `zone demo
  take host, like view
  zone div
    bind class, text <flex gap-2 bg-zinc-900>
    site`,
  )
  const u3 = (await runUsed()).join(' ')
  ok('usedClasses stable across a non-class edit', u1 === u2, u2)
  ok('usedClasses updates on a class edit', u3.includes('bg-zinc-900'))

  // 5) subscription: fires on the initial value and on a real change, not on a non-class edit
  const qc2 = new QueryCompiler()
  const subs = new Subscriptions(qc2.db)
  let fires = 0
  subs.on(
    cx => qc2.usedClasses(cx, F),
    () => {
      fires++
    },
  )
  qc2.setSource(
    'demo.tree',
    `zone demo
  take host, like view
  zone div
    bind class, text <flex gap-2>
    site`,
  )
  await subs.flush()
  const afterInitial = fires
  qc2.setSource(
    'demo.tree',
    `zone demo
  take host, like view
  zone div
    bind class, text <flex gap-2>
    zone span
      site`,
  )
  await subs.flush()
  const afterNonClass = fires
  qc2.setSource(
    'demo.tree',
    `zone demo
  take host, like view
  zone div
    bind class, text <flex gap-2 p-4>
    site`,
  )
  await subs.flush()
  const afterClass = fires
  ok('subscription fires on the initial value', afterInitial === 1)
  ok(
    'subscription does NOT fire on a non-class edit',
    afterNonClass === 1,
    `fires=${afterNonClass}`,
  )
  ok('subscription fires on a class change', afterClass === 2)

  console.log(`\nseed-verify JIT demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) {
    process.exit(1)
  }
}

main()
