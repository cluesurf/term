// Named loops: `walk ..., name outer` names a loop, and `halt, name outer` / `turn next, name outer` inside a loop
// nested in it leave or continue THAT loop rather than the innermost one. Every backend writes the name as its own loop
// label (`outer:` on TypeScript and Swift, `'outer:` on Rust, `outer@` on Kotlin). A counted walk steps its counter
// before a named `turn next` reaches it from inside a nested loop, or it would count the same row forever.
// Run: npx tsx test/compile/loop-name-native.ts   (LOOP_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { BACKENDS, runOn } from './shared/run-on'

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

// four loops that each need a name: a search that stops both loops at the first pair, a row skipped from inside the
// walk over its columns (a counted walk, so the counter must step), a list walk continued from inside a `walk test`,
// and a named loop whose unnamed `halt` still leaves only the innermost one
const PROGRAM = `load @term/base/list
  find list

task first-pair
  take xs, like list, like number
  take target, like number
  like text
  save found, <none>
  save tries, 0
  walk xs, name outer
    take a
    walk xs
      take b
      save tries, add(tries, 1)
      fork test, is-equal add(a, b), target
        hold
          save found, <{a}+{b} after {tries}>
          halt, name outer
  back found

task lower-triangle
  take n, like number
  like number
  save total, 0
  save done, 0
  walk size, name rows
    bind head, n
    hook next
      take site, name r
      walk size
        bind head, n
        hook next
          take site, name c
          fork test, is-above c, r
            hold
              turn next, name rows
          save total, add(total, 1)
      save done, add(done, 1)
  back add(multiply(total, 10), done)

task skip-words
  take words, like list, like text
  like number
  save kept, 0
  walk words, name each
    take word
    save at, 0
    walk test
      hook test, is-below at, 3
      hold
        save at, add(at, 1)
        fork test, is-equal word, <skip>
          hold
            turn next, name each
    save kept, add(kept, 1)
  back kept

task inner-only
  like number
  save count, 0
  walk make(list, 1, 2, 3), name outer
    take a
    walk make(list, 1, 2, 3)
      take b
      fork test, is-above b, 1
        hold
          halt
      save count, add(count, 1)
  back count

task grid-search
  like text
  save grid, make list, make(list, 3, 8), make(list, 5, 42), make(list, 42, 1)
  save found, <none>
  walk grid, name rows
    take row
    take r
    walk row
      take cell
      take c
      fork test, is-equal cell, 42
        hold
          save found, <{r}:{c}>
          halt, name rows
  back found

task run
  like text
  save pair, first-pair(make(list, 1, 4, 6, 9), 10)
  save rows, lower-triangle(4)
  save kept, skip-words(make(list, <a>, <skip>, <b>, <skip>))
  save inner, inner-only()
  send back, <{pair} {rows} {kept} {inner} {grid-search()}>
`

// 1+9 is found on the fourth try and nothing after it runs; rows 0..3 keep 1+2+3+4 cells, and only the last row's
// column walk runs to its end, every other row continued from inside it (an unnamed `turn next` would give 104); two
// words are kept; the unnamed halt leaves only the inner walk, so each of three outer turns counts one; the grid
// search stops at the first 42, row 1 column 1, where an unnamed halt would go on to row 2 column 0. The grid is a
// list of lists written out, whose rows walked by position did not build on Rust or Swift before 2026-10-05
const EXPECTED = '1+9 after 4 101 2 3 1:1'

const dir = mkdtempSync(join(tmpdir(), 'term-loop-name-'))
const only = process.env.LOOP_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'loops' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a named halt leaves both loops, a named turn next continues the outer walk (a counted one stepping its counter, and from inside a walk test), and an unnamed halt leaves the inner one`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

// the refusals, which need only the checker
if (!only || only === 'typescript') {
  const refused = (text: string): string[] => {
    const built = compile({ file: join(dir, 'refused.tree'), text }, { resolve: projectResolver(process.cwd(), 'node'), env: 'node' })

    return built.ok ? [] : built.diagnostics.map(d => d.message)
  }

  const nowhere = refused(`load @term/base/list\n  find list\n\ntask run\n  like number\n  walk make(list, 1), name outer\n    take a\n    halt, name inner\n  back 0\n`)
  ok('a halt naming no loop around it is refused, naming the loops that are', nowhere.some(m => m.includes('`halt, name inner` names no loop around it (the loops around it are named outer)')), nowhere.join(' | '))

  const turned = refused(`load @term/base/list\n  find list\n\ntask run\n  like number\n  walk make(list, 1)\n    take a\n    turn next, name outer\n  back 0\n`)
  ok('a turn next naming no loop around it is refused, saying none has a name', turned.some(m => m.includes('`turn next, name outer` names no loop around it, and none around it has a name')), turned.join(' | '))

  const twice = refused(`load @term/base/list\n  find list\n\ntask run\n  like number\n  walk make(list, 1), name outer\n    take a\n    walk make(list, 1), name outer\n      take b\n      halt, name outer\n  back 0\n`)
  ok('a loop named like the loop around it is refused', twice.some(m => m.includes('is named "outer" too')), twice.join(' | '))

  const outside = refused(`task run\n  like number\n  turn next, name outer\n  back 0\n`)
  ok('a named turn next outside any loop is refused as outside a loop', outside.some(m => m.includes('only valid inside a loop')), outside.join(' | '))
}

console.log(`\nloop-name-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
