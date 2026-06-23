// Backend tests: the recursive Fibonacci compiles to Swift, Kotlin, WGSL, and HVM with the expected shape.
// Run: npx tsx test/compile/backends.ts

import { parse } from '@cluesurf/make/code/parser/tree'
import { mill } from '@cluesurf/make/code/compile/mill'
import { resolve } from '@cluesurf/make/code/check/resolve'
import { check } from '@cluesurf/make/code/check/infer'
import { emitSwift } from '@cluesurf/make/code/compile/swift'
import { emitKotlin } from '@cluesurf/make/code/compile/kotlin'
import { emitWgsl } from '@cluesurf/make/code/compile/wgsl'
import { emitHvm } from '@cluesurf/make/code/compile/hvm'
import type { Program } from '@cluesurf/make/code/compile/node'

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

function frontEnd(text: string): Program {
  const parsed = parse({ file: 'b.tree', text })

  if (!parsed.ok) {throw new Error('parse failed')}

  const built = mill(parsed.tree, 'b.tree')

  if (!built.ok) {throw new Error('mill failed')}

  resolve(built.program, 'b.tree')
  check(built.program, 'b.tree')

  return built.program
}

const FIB = `task fibonacci
  take n, like number
  like number
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
          call fibonacci
            call subtract
              loan n
              code 1
          call fibonacci
            call subtract
              loan n
              code 2
`

function main(): void {
  const program = frontEnd(FIB)

  const swift = emitSwift(program)
  ok(
    'swift: function signature',
    swift.includes('func fibonacci(_ n: Int) -> Int'),
    swift,
  )
  ok(
    'swift: control flow + recursion',
    swift.includes('if ') &&
      swift.includes('return n') &&
      swift.includes('fibonacci('),
  )

  const kotlin = emitKotlin(program)
  ok(
    'kotlin: function signature',
    kotlin.includes('fun fibonacci(n: Long): Long'),
    kotlin,
  )
  ok(
    'kotlin: control flow + recursion',
    kotlin.includes('if (') &&
      kotlin.includes('return n') &&
      kotlin.includes('fibonacci('),
  )

  const wgsl = emitWgsl(program)
  ok(
    'wgsl: function signature',
    wgsl.includes('fn fibonacci(n: i32) -> i32'),
    wgsl,
  )
  ok(
    'wgsl: control flow + recursion',
    wgsl.includes('if (') &&
      wgsl.includes('return n;') &&
      wgsl.includes('fibonacci('),
  )

  // Richer forms: an algebraic data type with a field, a `match`, field access, record construction, and a throw.
  // The general-purpose targets (Swift, Kotlin) must lower every form; the restricted target (WGSL) must emit
  // an explicit SEED-UNSUPPORTED marker for forms outside its fragment, never silently drop them.
  const rich = frontEnd(`form box
  head t
  case full
    link value, like t
  case empty

  task get-or
    take self
    take other, like t
    like t
    fork case, read self
      case full
        send back, read self/value
      case empty
        send back, read other

task danger
  take n, like number
  like number
  fork test
    hook test
      call is-below
        loan n
        code 0
    hook hold
      bust
        text <oops>
    hook miss
      send back, read n
`)

  const sw = emitSwift(rich)
  ok(
    'swift: ADT native generic enum',
    sw.includes('enum Box<T>') &&
      sw.includes('case full(value: T)') &&
      sw.includes('case empty'),
    sw,
  )
  ok(
    'swift: match is a native switch with field binding',
    sw.includes('switch') && sw.includes('case let .full(value):'),
    sw,
  )
  ok(
    'swift: variant field access uses the bound local',
    sw.includes('return value'),
    sw,
  )
  ok(
    'swift: throw with the SeedError prelude',
    sw.includes('throw SeedError("oops")') &&
      sw.includes('struct SeedError'),
    sw,
  )

  const ko = emitKotlin(rich)
  ok(
    'kotlin: ADT sealed-class hierarchy',
    ko.includes('sealed class Box<out T>') &&
      ko.includes('data class BoxFull') &&
      ko.includes('object BoxEmpty'),
    ko,
  )
  ok(
    'kotlin: match is an exhaustive when with smart-cast',
    ko.includes('when (self)') &&
      ko.includes('is BoxFull ->') &&
      ko.includes('self.value'),
    ko,
  )
  ok(
    'kotlin: throw with the SeedError prelude',
    ko.includes('throw SeedError("oops")') &&
      ko.includes('class SeedError'),
    ko,
  )

  // restricted target: explicit markers, no silent drop, while still emitting the numeric functions it can
  const wgslRich = emitWgsl(rich)
  ok(
    'wgsl: marks forms outside its fragment',
    wgslRich.includes('SEED-UNSUPPORTED'),
    wgslRich,
  )
  ok(
    'wgsl: still emits the numeric function',
    wgslRich.includes('fn danger'),
    wgslRich,
  )

  // HVM: the recursive numeric fragment lowers to interaction-combinator definitions. Recursion is a self-reference to
  // `@fibonacci`, the `fork test` becomes a numeric match `(λ{0: else; _: λ&c. then})(cond)`, and arithmetic / comparison
  // map to HVM's native operators. This matches the canonical HVM fib idiom (see deck/fork-HVM4/test/fib_small.hvm).
  const hvm = emitHvm(program)
  ok(
    'hvm: emits an @fibonacci definition with an auto-dup parameter',
    hvm.includes('@fibonacci = λ&n.'),
    hvm,
  )
  ok(
    'hvm: recursion is a self-reference applied to a subtraction',
    hvm.includes('@fibonacci((n - 1))') &&
      hvm.includes('@fibonacci((n - 2))'),
    hvm,
  )
  ok(
    'hvm: the branch lowers to a numeric match on the comparison',
    hvm.includes('λ{0:') && hvm.includes('})((n < 2))'),
    hvm,
  )
  ok(
    'hvm: addition lowers to the native operator',
    /@fibonacci\(\(n - 1\)\) \+ @fibonacci\(\(n - 2\)\)/.test(hvm),
    hvm,
  )
  ok(
    'hvm: marked experimental in the emitted banner',
    hvm.startsWith('// EXPERIMENTAL backend: HVM'),
    hvm,
  )

  // a multi-argument arithmetic function becomes curried auto-dup lambdas with a native operator body
  const adder = frontEnd(`task add-two
  take a, like number
  take b, like number
  like number
  send back
    call add
      loan a
      loan b
`)
  ok(
    'hvm: a two-argument function curries auto-dup lambdas',
    emitHvm(adder).includes('@add_two = λ&a. λ&b. (a + b)'),
    emitHvm(adder),
  )

  console.log(`\nbackends: ${pass} pass, ${fail} fail`)
}

main()
