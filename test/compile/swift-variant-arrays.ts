// Swift holds a list a variant owns as a plain array (swift.ts, `fieldLists` over backend.ts `ownedFields`), and a list
// made empty and filled by a counted loop gets its room first (`reserveAt`). Held both ways: Storage's leaf items and
// node kids are `[Int]` and `[Storage]`, its kids reserved four, and an arm that pushes onto the list it binds keeps
// the variant's list a shared `SeedList`, since a plain array would take the push into a copy the variant never sees.
// The meaning fixtures (`variant-array`, `records`) hold the answers on Swift.
// Run: npx tsx test/compile/swift-variant-arrays.ts

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
const swift = (file: string, text = readFileSync(join(TERM, file), 'utf8')): string => {
  const built = compile({ file, text }, { resolve: withNativeEnv('swift', stdlibResolver()!), env: 'swift' })

  if (!built.ok) {
    throw new Error(`${file}: ${built.diagnostics[0]?.message}`)
  }

  return emitSwift(built.program)
}
const lines = (text: string, pattern: RegExp): string => text.split('\n').filter(l => pattern.test(l)).join(' | ')

// 1. Storage: both variants' lists plain arrays, built and read as the hand version does
const storage = swift('bench/storage/term.tree')
ok('storage: the leaf holds `[Int]`', /case leaf\(items: \[Int\]\)/.test(storage), lines(storage, /case leaf/))
ok('storage: the node holds `[Storage]`', /case node\(kids: \[Storage\]\)/.test(storage), lines(storage, /case node/))
ok('storage: the kids are a plain local, reserved for the four the loop pushes', /var kids: \[Storage\] = \[\]\n\s+kids\.reserveCapacity\(4\)/.test(storage), lines(storage, /kids/))
ok('storage: the arm walks the plain array', /for kid in kids \{/.test(storage) && !/kids\.data/.test(storage), lines(storage, /kids/))

// 2. an arm that pushes onto the list it binds: the variant's list stays shared, so the push reaches it
const pushed = swift(
  'pushed.tree',
  `load @term/base/list
  find list
  find push
  find size

form bag
  case empty
  case full
    link items, like list, like number

task grow
  take b, like bag
  like number
  fork case, read b
    case empty
      send back, code 0
    case full
      call push
        bind list, read items
        bind item, code 1
      send back, call size(read(items))

task compute
  like number
  host items
    make list
  call push
    bind list, read items
    bind item, code 7
  send back
    call grow
      make full
        bind items, read items
`,
)
ok('pushed: the variant keeps a shared `SeedList`', /case full\(items: SeedList<Int>\)/.test(pushed), lines(pushed, /case full/))

console.log(`\nswift-variant-arrays: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
