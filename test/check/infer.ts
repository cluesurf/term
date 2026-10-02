// Inference-engine tests: let-polymorphism (a generic used at two types), declared-annotation enforcement, and
// record field-existence. Run: npx tsx test/check/infer.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expectOk(name: string, source: string): void {
  const result = compile({ file: 'i.tree', text: source })

  if (result.ok) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (${result.diagnostics
        .map(d => d.message)
        .join('; ')})`,
    )
  }
}

function expectError(name: string, source: string, code: string): void {
  const result = compile({ file: 'i.tree', text: source })

  if (!result.ok && result.diagnostics.some(d => d.name === code)) {
    pass++
    console.log(
      `ok    ${name}  (${
        result.diagnostics.find(d => d.name === code)!.message
      })`,
    )
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, codes=${
        result.ok ? '' : result.diagnostics.map(d => d.name).join(',')
      })`,
    )
  }
}

function main(): void {
  // LET-POLYMORPHISM: a single generic identity called at a number AND at a string in the same program.
  // Without per-call instantiation, the generic result variable would unify to both and conflict.
  expectOk(
    'generic identity used at two types',
    `task identity
  head t
  take x, like t
  like t
  send back x

task use-number
  send back
    call identity
      code 5

task use-text
  send back
    call identity
      text <hi>
`,
  )

  // DECLARED ANNOTATION ENFORCED: a boolean parameter used in arithmetic is a type error (the annotation is
  // honored, not inferred away).
  expectError(
    'boolean param used as number',
    `task wrong
  take b, like boolean
  send back
    call add
      loan b
      code 1
`,
    'type-mismatch',
  )

  // FIELD-EXISTENCE: accessing a field the record does not declare is an error.
  expectError(
    'access to missing field',
    `form point
  link x, like u64
  link y, like u64

task bad
  take p, like point
  send back
    read p/z
`,
    'unknown-name',
  )

  // a valid field access on a declared record type still works
  expectOk(
    'access to present field',
    `form point
  link x, like u64
  link y, like u64

task good
  take p, like point
  send back
    read p/x
`,
  )

  // unused-binding warning: the program still compiles, but warns
  {
    const result = compile({
      file: 'i.tree',
      text: `task waste
  take n
  save unused, code 5
  send back n
`,
    })

    if (
      result.ok &&
      result.warnings.some(
        w =>
          w.name === 'unused-binding' && w.message.includes('unused'),
      )
    ) {
      pass++
      console.log(
        `ok    unused binding warned (not fatal)  (${
          result.warnings[0]!.message
        })`,
      )
    } else {
      fail++
      console.log(
        `FAIL  unused binding warning (ok=${result.ok}, warnings=${
          result.ok ? result.warnings.length : 'n/a'
        })`,
      )
    }
  }

  // dead private function: a `mark private` task nothing calls is warned; a used one and a public (unmarked) one are
  // not (a public definition may be called from outside this compilation).
  {
    const deadPrivate = (text: string): boolean => {
      const result = compile({ file: 'i.tree', text })

      return (
        result.ok &&
        result.warnings.some(
          w =>
            w.name === 'unused-binding' &&
            w.message.includes('private'),
        )
      )
    }

    const unused = `task helper\n  mark private\n  send back, code 1\n\ntask main\n  send back, code 2\n`
    const used = `task helper\n  mark private\n  send back, code 1\n\ntask main\n  send back\n    call helper\n`
    const publicUnused = `task helper\n  send back, code 1\n\ntask main\n  send back, code 2\n`

    const cases: [string, boolean][] = [
      [
        'an unused private function is warned',
        deadPrivate(unused) === true,
      ],
      [
        'a used private function is not warned',
        deadPrivate(used) === false,
      ],
      [
        'an unused PUBLIC function is not warned',
        deadPrivate(publicUnused) === false,
      ],
    ]

    for (const [label, cond] of cases) {
      if (cond) {
        pass++
        console.log(`ok    ${label}`)
      } else {
        fail++
        console.log(`FAIL  ${label}`)
      }
    }
  }

  // a fully-used function produces no warnings
  {
    const result = compile({
      file: 'i.tree',
      text: `task clean\n  take n\n  save m, loan n\n  back m\n`,
    })

    if (result.ok && result.warnings.length === 0) {
      pass++
      console.log('ok    no warnings when all used')
    } else {
      fail++
      console.log(`FAIL  expected no warnings (ok=${result.ok})`)
    }
  }

  // MAP TYPING: a map literal infers a homogeneous map type; inconsistent values are caught (no longer `unknown`)
  expectOk(
    'consistent map literal type-checks',
    `task scores
  host table
    make find
      save alice, code 1
      save bob, code 2
  send back table
`,
  )
  expectError(
    'inconsistent map values are caught',
    `task bad
  host table
    make find
      save alice, code 1
      save bob, true
  send back table
`,
    'type-mismatch',
  )

  // FIRST-CLASS FUNCTIONS: passing a wrong-typed task is caught by unifying the function types
  expectError(
    'passing a wrong-typed function is rejected',
    `task takes-number-fn
  take f
    like task
      take x, like number
      like number
  like number
  send back
    call f
      code 1

task wrong
  take b, like boolean
  like boolean
  send back b

task run
  like number
  send back
    call takes-number-fn
      read wrong
`,
    'type-mismatch',
  )

  // LET-GENERALIZATION: a generic task bound to an immutable local stays polymorphic, so it is usable at two types
  expectOk(
    'a bound generic task is used at two types (let-generalization)',
    `task identity
  head t
  take x, like t
  like t
  send back x

task run
  like number
  host id
    read identity
  save a
    call id
      code 1
  save b
    call id
      text <hello>
  send back a
`,
  )

  // ARITY OVERLOADING: two functions may share a name at different arities; each call resolves by argument count.
  expectOk(
    'same-name functions at different arities (overloading)',
    `task render
  take n, like number
  like text
  send back
    text <one>

task render
  take n, like number
  take base, like number
  like text
  send back
    text <two>

task use-one
  like text
  send back
    call render
      code 42

task use-two
  like text
  send back
    call render
      code 42
      code 16
`,
  )

  // same name AND same arity is not an overload: it is last-wins (template-generated constants rely on this), so it
  // compiles rather than erroring -- overloading only distinguishes different arities
  expectOk(
    'same-name same-arity is last-wins (not an overload)',
    `task render
  take n, like number
  like text
  send back
    text <a>

task render
  take m, like number
  like text
  send back
    text <b>
`,
  )

  // NESTED NAMED TASK: the language has none (a task is top-level, a local function is a closure in value
  // position). Under a `hook hold` it reached checkFunction with no registered signature and THREW
  // `Cannot read properties of undefined (reading 'bounds')` (found by `term hunt`, 2026-10-02); directly under a
  // task it was dropped in silence. Each position is now one `unexpected-node` and never a throw.
  const nested: [string, string][] = [
    [
      'nested task under hook hold is refused, not a crash',
      `task pick
  take a, like number
  take b, like number
  like number
  fork test
    hook test
      call is-above
        read a
        read b
    hook hold
      task back
        read a
    hook miss
      send back
        read b
`,
    ],
    [
      'nested task directly under a task is refused, not dropped',
      `task pick
  take a, like number
  like number
  task twice
    take n, like number
    like number
    send back
      call add
        read n
        read n
  send back
    read a
`,
    ],
    [
      'nested task inside a walk body is refused, not a crash',
      `task total
  take items, like list, like number
  like number
  save sum, code 0
  walk list, read items
    hook next
      take site, name item
      task inner
        read item
  send back, read sum
`,
    ],
  ]

  for (const [name, source] of nested) {
    try {
      const result = compile({ file: 'i.tree', text: source })
      const hit = result.ok
        ? undefined
        : result.diagnostics.find(
            d =>
              d.name === 'unexpected-node' &&
              d.message.includes('cannot be defined inside a body'),
          )

      if (hit) {
        pass++
        console.log(`ok    ${name}  (${hit.message})`)
      } else {
        fail++
        console.log(
          `FAIL  ${name}  (ok=${result.ok}, codes=${
            result.ok ? '' : result.diagnostics.map(d => d.name).join(',')
          })`,
        )
      }
    } catch (error) {
      fail++
      console.log(`FAIL  ${name}  (threw: ${(error as Error).message})`)
    }
  }

  // the control: the same helper written at the top level compiles and is called
  expectOk(
    'the helper at the top level compiles',
    `task twice
  take n, like number
  like number
  send back
    call add
      read n
      read n

task pick
  take a, like number
  like number
  send back
    call twice
      read a
`,
  )

  console.log(`\ninfer: ${pass} pass, ${fail} fail`)
}

main()
