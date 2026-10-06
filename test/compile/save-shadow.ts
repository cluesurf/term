// A `save` that declares a name its own value reads, reads the OUTER binding of that name: a `fork case` arm's field,
// or a module constant. `save radius, add(radius, 1)` under `case circle` is one more than the field. It declared the
// new local first, so the value read that local before it existed: a TypeError on TypeScript (`let radius =
// add(radius, 1)`), and every compile through the ported simplifier stopped on one (2026-10-06). The new local takes a
// fresh name in the bridge (compile/mint-bridge.ts `readsVariable`), and the uses after it follow it.
// Run: npx tsx test/compile/save-shadow.ts   (SHADOW_ONLY=typescript, rust, swift or kotlin runs one)

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

const PROGRAM = `form shape
  case circle
    link radius, like number
  case square
    link side, like number

host limit, 5

task grow
  take s, like shape
  like number
  sift s
    case circle
      save radius, add(radius, 1)
      save radius, multiply(radius, 2)
      back radius
    case square
      back side

task raise
  like number
  save limit, add(limit, 1)
  back limit

# a field the arm ASSIGNS, which a backend must declare as a variable and not a constant
task bump
  take s, like shape
  like number
  sift s
    case circle
      save radius, add(radius, 10)
      back radius
    case square
      back side

task run
  like text
  back <{grow(make(circle, 3))}|{grow(make(square, 7))}|{raise()}|{bump(make(circle, 1))}>
`

const only = process.env.SHADOW_ONLY
const dir = mkdtempSync(join(tmpdir(), 'term-save-shadow-'))

for (const backend of BACKENDS.filter(one => !only || one === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'shadow' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  // the circle: (3 + 1) * 2; the square, its side; the constant, one past itself; the bumped field, 1 + 10
  ok(`${backend}: a save reading its own name reads the field, and the uses after it the new local`, ran.form === 'ran' && ran.output === '8|7|6|11', ran.form === 'ran' ? ran.output : `${ran.stage}: ${ran.reason}`)
}

// an arm whose field hides an outer variable, and which WRITES that name: the write is the field's and is lost, and
// TypeScript refused it as an assignment to a constant (deck/host/test/base.tree, 2026-10-06). Refused here instead
const HIDDEN = (body: string): string => `form shape
  case circle
    link radius, like number
  case square
    link side, like number

task outer
  take s, like shape
  like number
  save radius, 0
  sift s
    case circle
${body}
    case square
      save radius, side
  back radius
`
const written = compile({ file: 'h.tree', text: HIDDEN('      save radius, add(radius, 1)') })
ok(
  'an arm that writes a name its field hides is refused, naming both',
  !written.ok && written.diagnostics.some(d => /writes the field, not the "radius" outside it/.test(d.message)),
  written.ok ? 'compiled' : written.diagnostics.map(d => d.message).join(' | '),
)

const readOnly = compile({ file: 'h.tree', text: HIDDEN('      back add(radius, 1)') })
ok(
  'an arm that only reads the hidden name still builds, with its warning',
  readOnly.ok && readOnly.warnings.some(w => w.name === 'arm-shadow'),
  readOnly.ok ? readOnly.warnings.map(w => w.name).join(',') : readOnly.diagnostics.map(d => d.message).join(' | '),
)

console.log(`\nsave-shadow: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
