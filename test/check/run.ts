// Resolution and type-checking tests: confirm the resolver catches unknown names and the checker catches type
// mismatches and arity errors. Run: npx tsx test/check/run.ts

import { compile } from '@/code/compile/compile'
import { render } from '@/code/parser/diagnostic'

let pass = 0
let fail = 0

// confirm a type error blames more than one location (multi-span)
function expectBlame(name: string, source: string): void {
  const result = compile({ file: 'bad.tree', text: source })
  if (result.ok) {
    fail++
    console.log(`FAIL  ${name}  (compiled cleanly, expected a blamed type error)`)
    return
  }
  const markers = result.diagnostics[0]?.markers ?? []
  if (markers.length >= 2) {
    pass++
    console.log(`ok    ${name}  (${markers.length} spans)`)
    console.log(
      render(result.diagnostics[0]!, source.split('\n'), false)
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n'),
    )
  } else {
    fail++
    console.log(`FAIL  ${name}  (only ${markers.length} span, expected multi-span)`)
  }
}

function expectError(name: string, source: string, code: string): void {
  const result = compile({ file: 'bad.tree', text: source })
  if (result.ok) {
    fail++
    console.log(`FAIL  ${name}  (compiled cleanly, expected ${code})`)
    return
  }
  const got = result.diagnostics[0]?.name
  if (got === code) {
    pass++
    console.log(`ok    ${name}  (${result.diagnostics[0]!.message})`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${got}, want ${code})`)
  }
}

function expectOk(name: string, source: string): void {
  const result = compile({ file: 'good.tree', text: source })
  if (result.ok) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (${result.diagnostics.map((d) => d.message).join('; ')})`)
  }
}

function main(): void {
  // unknown name: `missing` is not defined
  expectError(
    'unknown name',
    `task bad
  take n
  back
    call add
      loan n
      loan missing
`,
    'unknown-name',
  )

  // type mismatch: adding a string to a number
  expectError(
    'type mismatch (string + number)',
    `task bad
  take n
  save s, text <hi>
  back
    call add
      loan n
      loan s
`,
    'type-mismatch',
  )

  // type mismatch: a non-boolean loop condition
  expectError(
    'type mismatch (number condition)',
    `task bad
  take n
  walk test
    hook test
      loan n
    hook step
      save n, mark 0
  back n
`,
    'type-mismatch',
  )

  // arity mismatch: calling a one-argument function with two arguments
  expectError(
    'arity mismatch',
    `task one
  take a
  back a

task bad
  take n
  back
    call one
      loan n
      loan n
`,
    'type-mismatch',
  )

  // a clean program with a forward reference (helper defined after use) resolves and checks
  expectOk(
    'forward reference resolves',
    `task main
  take n
  back
    call helper
      loan n

task helper
  take x
  back
    call add
      loan x
      mark 1
`,
  )

  // multi-span blame: n is used as boolean (loop condition) and as a number (assignment)
  expectBlame(
    'blame points at both uses',
    `task bad
  take n
  walk test
    hook test
      loan n
    hook step
      save n, mark 0
  back n
`,
  )

  console.log(`\ncheck: ${pass} pass, ${fail} fail`)
}

main()
