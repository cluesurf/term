// A field returned off a `walk` item the Rust backend holds BY REFERENCE is cloned out, never moved. The walk over a
// list it only reads binds each item as `&T` (rust.ts, the array walk's `byRef`), and `return one.ascii` moved out of
// the borrow: rustc E0507, at 41 sites of the terminal output library's 23 modules on 2026-10-04 (`find-symbol` in
// deck/call/code/work/item/layout.tree is the shape). The program is built with rustc and run.
//
// Run: npx tsx test/compile/borrow-return.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { runDir } from './run-dir'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

const SOURCE = `form symbol
  link name, like text
  link unicode, like text
  link ascii, like text

task find-symbol
  take symbols, like list, like symbol
  take name, like text
  take ascii, like boolean
  like text
  walk symbols
    take one
    fork test, is-equal(one/name, name)
      hold
        fork test, ascii
          hold
            back one/ascii
        back one/unicode
  back <>
`

const built = compile({ file: '/gate/code/borrow.tree', text: SOURCE }, { leanOf: () => true, env: 'rust' })

if (!built.ok) {
  ok('the program compiles', false, built.diagnostics.map(d => d.message).join(' | '))
} else if (!have('rustc')) {
  skip++
  console.log('skip  rust: borrowed field return  (rustc not installed)')
} else {
  const rust = emitRust(built.program)
  ok('the walk holds the item by reference', /let one = __item;/.test(rust), rust.slice(0, 400))
  ok('a returned field is cloned out of the borrow', /return one\.ascii\.clone\(\);/.test(rust) && /return one\.unicode\.clone\(\);/.test(rust))

  const dir = runDir('term-borrow-return-')
  const main = join(dir, 'main.rs')
  writeFileSync(
    main,
    `#![allow(dead_code, unused_mut)]\n${rust}\nfn main() { let symbols = vec![Symbol { name: "more".to_string(), unicode: "…".to_string(), ascii: "...".to_string() }]; println!("{}|{}|{}", find_symbol(&symbols, "more".to_string(), true), find_symbol(&symbols, "more".to_string(), false), find_symbol(&symbols, "none".to_string(), true)); }\n`,
  )

  try {
    execFileSync('rustc', ['--edition', '2021', '-o', join(dir, 'main'), main], { stdio: 'pipe' })
    ok('rust: it builds', true)
    const run = spawnSync(join(dir, 'main'), [], { encoding: 'utf8' })
    ok('rust: it answers', run.stdout.trim() === '...|…|', JSON.stringify(run.stdout + run.stderr))
  } catch (error) {
    ok('rust: it builds', false, String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 600))
  }
}

console.log(`\nborrow-return: ${pass} pass, ${fail} fail${skip ? `, ${skip} skipped` : ''}`)

if (fail > 0) {
  process.exit(1)
}
