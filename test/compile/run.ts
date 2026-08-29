// End-to-end compile test: Fibonacci, iterative and recursive, from tree source to nice TypeScript, then run the
// emitted module (hot-module-reload style: write it, import it, call it). Run: npx tsx test/compile/run.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { render } from '@term/make/code/parser/diagnostic'

const FIB_LOOP = `task find-fibonacci-via-loop
  take n
  save a, code 0
  save b, code 1
  walk test
    hook test
      call is-above
        loan n
        code 0
    hook step
      save next
        call add
          loan a
          loan b
      save a, loan b
      save b, loan next
      save n
        call subtract
          loan n
          code 1
  send back a
`

// a conditional in value position (`save x / fork test / ...`): lowers to a ternary chain, not statement branching
const CONDITIONAL_EXPRESSION = `task classify
  take n
  like text
  save label
    fork test
      hook test
        call is-above
          loan n
          code 0
      hook hold
        text <positive>
      hook miss
        text <non-positive>
  send back, read label
`

const FIB_RECURSION = `task find-fibonacci-via-recursion
  take n
  fork test
    hook test
      call is-below
        loan n
        code 2
    hook hold
      send back n
    hook miss
      send back
        call add
          call find-fibonacci-via-recursion
            call subtract
              loan n
              code 1
          call find-fibonacci-via-recursion
            call subtract
              loan n
              code 2
`

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

async function loadModule(
  source: string,
): Promise<Record<string, (n: number) => number>> {
  const result = compile({ file: 'fibonacci.tree', text: source })

  if (!result.ok) {
    const lines = source.split('\n')

    for (const d of result.diagnostics)
      {console.log(render(d, lines, false))}

    throw new Error('compile failed')
  }

  console.log('--- emitted TypeScript ---')
  console.log(result.typescript)

  const dir = mkdtempSync(join(tmpdir(), 'seed-compile-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)

  return (await import(pathToFileURL(file).href)) as Record<
    string,
    (n: number) => number
  >
}

async function main(): Promise<void> {
  const loop = await loadModule(FIB_LOOP)
  expect('loop fib(0)', loop.findFibonacciViaLoop(0), 0)
  expect('loop fib(1)', loop.findFibonacciViaLoop(1), 1)
  expect('loop fib(10)', loop.findFibonacciViaLoop(10), 55)
  expect('loop fib(20)', loop.findFibonacciViaLoop(20), 6765)

  const recursion = await loadModule(FIB_RECURSION)
  expect('recursion fib(0)', recursion.findFibonacciViaRecursion(0), 0)
  expect('recursion fib(1)', recursion.findFibonacciViaRecursion(1), 1)
  expect(
    'recursion fib(10)',
    recursion.findFibonacciViaRecursion(10),
    55,
  )
  expect(
    'recursion fib(15)',
    recursion.findFibonacciViaRecursion(15),
    610,
  )

  // a value-position conditional emits a ternary and computes the right branch at runtime
  const conditional = compile({
    file: 'classify.tree',
    text: CONDITIONAL_EXPRESSION,
  })

  if (!conditional.ok) {
    const lines = CONDITIONAL_EXPRESSION.split('\n')

    for (const d of conditional.diagnostics)
      {console.log(render(d, lines, false))}

    throw new Error('conditional compile failed')
  }

  expect(
    'conditional expression emits a ternary',
    / \? .* : /.test(conditional.typescript),
    true,
  )

  const dir = mkdtempSync(join(tmpdir(), 'seed-conditional-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, conditional.typescript)

  const mod = (await import(pathToFileURL(file).href)) as {
    classify: (n: number) => string
  }

  expect('classify(5)', mod.classify(5), 'positive')
  expect('classify(-3)', mod.classify(-3), 'non-positive')
  expect('classify(0)', mod.classify(0), 'non-positive')

  // a mistake the compiler used to accept silently is a diagnostic at the site
  const findAs = compile({ file: 'a.tree', text: 'load ./x\n  find get as pick\n\ntask f\n  like number\n  send back, code 1\n' })
  expect(
    '`find get as pick` is refused at the import and names the alias form',
    !findAs.ok && findAs.diagnostics.some(d => d.message.includes('find get, name pick')),
    true,
  )

  const braced = compile({ file: 'b.tree', text: 'task f\n  take items, like list\n    like number\n  like number\n  send back, read items/{0}\n' })
  expect(
    '`read items/{0}` is refused and names /0',
    !braced.ok && braced.diagnostics.some(d => d.message.includes('write /0')),
    true,
  )

  // a brace in a plain text literal used to compile to an empty string: a template parameter outside a template, or
  // the runtime interpolation that is not built yet
  const templateBrace = compile({ file: 't.tree', text: 'task f\n  take x, like text\n  like text\n  send back, text <a/{x}/b>\n' })
  expect(
    '`{x}` in a plain text literal is refused and names {{x}}',
    !templateBrace.ok && templateBrace.diagnostics.some(d => d.message.includes('"{x}" in a text literal is a template parameter') && d.message.includes('{{x}}')),
    true,
  )

  // runtime interpolation: `{{x}}` and `{{e/form}}` in a text literal, a template literal on TypeScript
  const runtimeBrace = compile({ file: 'r.tree', text: 'task f\n  take x, like text\n  take n, like number\n  like text\n  send back, text <a/{{x}}/b {{n}}>\n' })
  expect(
    '`{{x}}` interpolates at run time as a template literal',
    runtimeBrace.ok && runtimeBrace.typescript.includes('return `a/${x}/b ${n}`'),
    true,
  )

  const pathBrace = compile({ file: 'q.tree', text: 'form pair\n  link left, like text\n  link right, like text\n\ntask f\n  take p, like pair\n  like text\n  send back, text <{{p/left}}-{{p/right}}>\n' })
  expect(
    '`{{p/left}}` interpolates a path',
    pathBrace.ok && pathBrace.typescript.includes('return `${p.left}-${p.right}`'),
    true,
  )

  const unknownInterpolation = compile({ file: 'u.tree', text: 'task f\n  like text\n  send back, text <a {{nothing}} b>\n' })
  expect(
    'an interpolated name that does not exist is refused',
    !unknownInterpolation.ok && unknownInterpolation.diagnostics.some(d => d.message.includes('"nothing" is not defined')),
    true,
  )

  const escaped = compile({ file: 'e.tree', text: 'task f\n  like text\n  send back, text <a \\{x\\} b>\n' })
  expect('escaped braces stay literal text', escaped.ok && escaped.typescript.includes('"a {x} b"'), true)

  console.log(`\ncompile: ${pass} pass, ${fail} fail`)
}

main()
