// Which recursive forms Swift holds in a final class, their nodes reused (swift.ts, `nodeClasses`), held both ways. A
// form takes it only where some task opens a node at a local's last read and builds one, since the class alone measured
// slower than `indirect`: a wrong class costs time and never an answer, because a node is built again only when
// `isKnownUniquelyReferenced` says nothing else holds it. The meaning fixtures `payload` and `slot` hold the answers.
// Run: npx tsx test/compile/swift-node.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const TERM = join(import.meta.dirname, '../..')
const stdlib = stdlibResolver()!
const swift = (file: string, entry: string, text = readFileSync(file, 'utf8')): string => {
  const built = compile({ file, text }, { resolve: withNativeEnv('swift', stdlib), env: 'swift', entryPoints: [entry] })

  if (!built.ok) {
    throw new Error(`${file}: ${built.diagnostics[0]?.message}`)
  }

  return emitSwift(built.program)
}
const lines = (text: string, pattern: RegExp): string => text.split('\n').filter(l => pattern.test(l)).join(' | ')

// 1. Towers: the move pops a node at its local's last read and pushes one, so `stack` is a node class, the pop's match
// consumes its subject and keeps the node, and the push builds in the spare
const towers = swift(join(TERM, 'mark/towers/term.tree'), 'towers')
ok('towers: the payload case holds a final class', /case disk\(StackDisk\)/.test(towers) && /final class StackDisk \{/.test(towers) && !/indirect enum Stack/.test(towers), lines(towers, /Stack/))
ok('towers: the pop consumes its subject and keeps the node', /switch consume top\d*/.test(towers) && /isKnownUniquelyReferenced\(&__node\) \{ __spareStack = __node \}/.test(towers), lines(towers, /consume|isKnown/))
ok('towers: the push builds in the spare', /termNodeStackDisk\(&__spareStack, /.test(towers), lines(towers, /termNode/))
ok('towers: the class compares by its fields', /a === b \|\| \(a\.size == b\.size && a\.below == b\.below\)/.test(towers), lines(towers, /extension StackDisk/))
ok('towers: a task that only builds builds new', /\.disk\(StackDisk\(size: i, below: top\d*\)\)/.test(towers), lines(towers, /\.disk\(/))

// 2. binary-trees builds trees and reads them through a parameter, opening nothing at a local's last read: `indirect`
const trees = swift(join(TERM, 'mark/binary-trees/term.tree'), 'binary-trees')
ok('binary-trees: the tree stays an indirect enum', /indirect enum Tree/.test(trees) && !/final class Tree/.test(trees), lines(trees, /enum Tree|class Tree/))

// 3. a node opened only from a parameter, then built: a parameter cannot be consumed, so nothing is kept
const param = swift(
  'main.tree',
  'use',
  `form chain
  case stop
  case link
    link head, like number
    link rest, like chain

task use
  take c, like chain
  like chain
  fork case, read c
    case stop
      send back
        make stop
    case link
      send back
        make link
          bind head
            call add
              read head
              code 1
          bind rest, read rest
`,
)
ok('a node opened only from a parameter: indirect', /indirect enum Chain/.test(param) && !/__spare/.test(param), lines(param, /Chain|__spare/))

// 4. a form with two cases that hold it: no one payload case, so `indirect`
const two = swift(
  'main.tree',
  'use',
  `form knot
  case tip
  case one
    link value, like number
    link next, like knot
  case two
    link left, like knot
    link right, like knot

task use
  take n, like number
  like number
  host t
    make one
      bind value, read n
      bind next
        make tip
  fork case, read t
    case tip
      send back, code 0
    case one
      host u
        make one
          bind value, read value
          bind next, read next
      send back, read value
    case two
      send back, code 2
`,
)
ok('two cases holding the form: indirect', /indirect enum Knot/.test(two) && !/final class Knot/.test(two), lines(two, /enum Knot|final class/))

console.log(`\nswift-node: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
