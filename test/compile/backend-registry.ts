// Backend registry test: the stability registry is the single source of truth for which backends are production-ready
// and which are experimental, and the experimental backends (WGSL, HVM) stamp their output with a banner stating why.
// Run: npx tsx test/compile/backend-registry.ts

import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { emitWgsl } from '@term/make/code/compile/wgsl'
import {
  BACKENDS,
  backendInfo,
  isExperimentalBackend,
  experimentalNotice,
  experimentalBanner,
} from '@term/make/code/compile/backend-registry'
import type { Program } from '@term/make/code/compile/node'

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

  if (!parsed.ok) {
    throw new Error('parse failed')
  }

  const built = mill(parsed.tree, 'b.tree')

  if (!built.ok) {
    throw new Error('mill failed')
  }

  resolve(built.program, 'b.tree')
  check(built.program, 'b.tree')

  return built.program
}

// the four production backends are stable with no limitations
for (const name of ['typescript', 'rust', 'swift', 'kotlin']) {
  ok(`${name} is stable`, backendInfo(name)?.stability === 'stable')
  ok(`${name} is not experimental`, !isExperimentalBackend(name))
  ok(`${name} lists no limitations`, backendInfo(name)?.limitations.length === 0)
}

// wgsl, hvm are experimental and each documents at least one concrete limitation
for (const name of ['wgsl', 'hvm']) {
  ok(`${name} is experimental`, isExperimentalBackend(name))
  ok(
    `${name} documents limitations`,
    (backendInfo(name)?.limitations.length ?? 0) >= 1,
  )
  ok(
    `${name} notice leads with EXPERIMENTAL`,
    experimentalNotice(name)[0]?.startsWith('EXPERIMENTAL backend:') ===
      true,
  )
}

// the documented limitations name the headline constraints
ok(
  'hvm notice mentions the pure fragment',
  experimentalNotice('hvm').some(l => l.toLowerCase().includes('fragment')),
)
ok(
  'wgsl notice mentions numeric-only',
  experimentalNotice('wgsl').some(l =>
    l.toLowerCase().includes('numeric-only'),
  ),
)

// a stable backend has no banner; an experimental one uses the requested comment prefix
ok('stable backend has empty banner', experimentalBanner('rust', '//') === '')
ok(
  'hvm banner uses the // comment prefix',
  experimentalBanner('hvm', '//').startsWith('// EXPERIMENTAL backend: HVM'),
)
ok(
  'wgsl banner uses the // comment prefix',
  experimentalBanner('wgsl', '//').startsWith(
    '// EXPERIMENTAL backend: WGSL',
  ),
)

// an unknown backend is treated as having no banner / notice (never throws)
ok('unknown backend has no notice', experimentalNotice('java').length === 0)
ok('unknown backend is not experimental', !isExperimentalBackend('java'))

// the emitters actually stamp their output with the banner
const DOUBLE = `task double
  take n, like number
  like number
  send back
    call add
      read n
      read n
`
const program = frontEnd(DOUBLE)
ok(
  'emitted WGSL begins with the experimental banner',
  emitWgsl(program).startsWith('// EXPERIMENTAL backend: WGSL'),
)

// every backend is registered exactly once and the table is internally consistent
ok(
  'every registry entry name matches its key',
  Object.entries(BACKENDS).every(([key, info]) => key === info.name),
)

console.log(`\nbackend-registry: ${pass} pass, ${fail} fail`)
