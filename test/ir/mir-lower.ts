// IR -> Perceus MIR lowering tests: a real compiled function body lowers to ANF, heap-owned bindings are classified,
// and the result drives correct dup/drop through perceusControl. Run: npx tsx test/ir/mir-lower.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import { lowerToMir } from '@cluesurf/make/code/ir/mir-lower'
import { perceusControl, showInst } from '@cluesurf/make/code/ir/perceus'

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

function fnOf(src: string, name: string): { body: unknown; params: unknown } {
  const r = compile({ file: 't.tree', text: src })
  if (!r.ok) {
    throw new Error('compile failed: ' + JSON.stringify(r.diagnostics))
  }
  const fn = r.program.find(
    s => s.form === 'function' && s.name === name,
  )
  if (!fn || fn.form !== 'function') {
    throw new Error(`no function ${name}`)
  }
  return { body: fn.body, params: fn.params }
}

function main(): void {
  // a function that builds a record (heap) and returns it: the record binding is classified heap, the numeric field
  // literal stays copyable, and the returned value is not dropped (its ownership passes out)
  {
    const { body, params } = fnOf(
      `form box\n  link n, like number\n\ntask build\n  like box\n  send back\n    make box\n      bind n, code 5\n`,
      'build',
    )
    const { insts, heap } = lowerToMir(body as never, params as never)
    const mir = insts.map(showInst)

    ok(
      'record build: the make is lowered',
      mir.some(l => l.includes('make box')),
      JSON.stringify(mir),
    )
    ok(
      'record build: exactly the record binding is heap (the literal is copyable)',
      heap.size === 1,
      JSON.stringify([...heap]),
    )

    const rc = perceusControl(
      (params as { name: string }[]).map(p => p.name),
      insts,
      heap,
    )
    ok(
      'record build: returned value is not dropped',
      !rc.map(showInst).some(l => l.startsWith('drop')),
      JSON.stringify(rc.map(showInst)),
    )
  }

  // a heap parameter used twice gets a dup at the earlier use; the analysis fires through the lowered call
  {
    const { body, params } = fnOf(
      `form box\n  link n, like number\n\ntask pick\n  take a, like box\n  take b, like box\n  like box\n  send back, read a\n\ntask twice\n  take b, like box\n  like box\n  send back\n    call pick\n      read b\n      read b\n`,
      'twice',
    )
    const { insts, heap } = lowerToMir(body as never, params as never)
    ok(
      'heap param `b` is in the RC set',
      heap.has('b'),
      JSON.stringify([...heap]),
    )

    const rc = perceusControl(
      (params as { name: string }[]).map(p => p.name),
      insts,
      heap,
    )
    ok(
      'heap param used twice gets a dup',
      rc.map(showInst).some(l => l === 'dup b'),
      JSON.stringify(rc.map(showInst)),
    )
  }

  console.log(`\nmir-lower: ${pass} pass, ${fail} fail`)
}

main()
