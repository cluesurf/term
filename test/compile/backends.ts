// Backend tests: the recursive Fibonacci compiles to LLVM IR, Swift, Kotlin, and WGSL with the expected shape.
// Run: npx tsx test/compile/backends.ts

import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { resolve } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { emitSwift } from '@/code/compile/swift'
import { emitKotlin } from '@/code/compile/kotlin'
import { emitWgsl } from '@/code/compile/wgsl'
import { emitLlvm } from '@/code/compile/llvm'
import type { Program } from '@/code/compile/node'

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
  if (!parsed.ok) throw new Error('parse failed')
  const built = mill(parsed.tree, 'b.tree')
  if (!built.ok) throw new Error('mill failed')
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
        mark 2
    hook hold
      send back n
    hook miss
      send back
        call add
          call fibonacci
            call subtract
              loan n
              mark 1
          call fibonacci
            call subtract
              loan n
              mark 2
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

  const llvm = emitLlvm(program)
  ok(
    'llvm: define',
    llvm.includes('define i64 @fibonacci(i64 %n)'),
    llvm,
  )
  ok(
    'llvm: comparison + branch',
    llvm.includes('icmp slt i64') && llvm.includes('br i1'),
  )
  ok(
    'llvm: call + ret',
    llvm.includes('call i64 @fibonacci(i64') &&
      llvm.includes('ret i64'),
  )

  // Richer forms: an algebraic data type with a field, a `match`, field access, record construction, and a throw.
  // The general-purpose targets (Swift, Kotlin) must lower every form; the restricted targets (LLVM, WGSL) must emit
  // an explicit SEED-UNSUPPORTED marker for forms outside their fragment, never silently drop them.
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
        mark 0
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

  // restricted targets: explicit markers, no silent drop, while still emitting the numeric functions they can
  const llvmRich = emitLlvm(rich)
  ok(
    'llvm: marks forms outside its fragment',
    llvmRich.includes('SEED-UNSUPPORTED'),
    llvmRich,
  )
  ok(
    'llvm: still emits the numeric function',
    llvmRich.includes('define i64 @danger'),
    llvmRich,
  )

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

  // LLVM strings: a string-returning function is typed as a pointer and lowered through the managed runtime
  const strings = frontEnd(
    'task greeting\n  like text\n  send back\n    call add\n      text <hi >\n      text <there>\n',
  )
  const llvmStr = emitLlvm(strings)
  ok(
    'llvm: declares the string runtime',
    llvmStr.includes('declare ptr @seed_str_concat(ptr, ptr)'),
    llvmStr,
  )
  ok(
    'llvm: string literals are module constants',
    llvmStr.includes('private unnamed_addr constant'),
    llvmStr,
  )
  ok(
    'llvm: concatenation lowers to the runtime, returning a pointer',
    llvmStr.includes('call ptr @seed_str_concat') &&
      llvmStr.includes('ret ptr'),
    llvmStr,
  )

  console.log(`\nbackends: ${pass} pass, ${fail} fail`)
}

main()
