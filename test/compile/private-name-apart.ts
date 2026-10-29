// ONE NAME, TWO MODULES, ONE OF THEM PRIVATE. `priv.tree` has a private task `is-given`, `pub.tree` a public
// `is-given` of its own, and the entry finds `pub`'s through its import. The entry means `pub`'s, in the merged build
// and the separate one alike, and nothing is refused as `private-name` (term-compiler-0068).
//
// The separate build refused it when `pub`'s was a native binding (`bind is-given`). Its own unit renamed the binding
// apart from the task its closure reached (`is-given__native0`, check/disambiguate.tree `bind-natives-apart`), and the
// stub carried that name, so in the entry's unit `pub` defined no `is-given` (`unknown-name`), or, where the entry's
// closure held `priv`'s task too, the reference bound to that private task (`private-name`: flow's code-actions.tree
// and navigation.tree against @term/make's templates.tree). A stub now carries a binding under its written name
// (compile/stub.ts), as it does a `host` value.
// Run: npx tsx test/compile/private-name-apart.ts

import { compile } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'

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

type Built = {
  ok: boolean
  typescript?: string
  diagnostics?: { name: string; message: string }[]
}

const said = (r: Built): string =>
  r.ok
    ? 'ok'
    : (r.diagnostics ?? [])
        .map(d => `${d.name}: ${d.message}`)
        .join(' | ')

const slug = (file: string): string =>
  `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

const resolverOf =
  (files: Record<string, string>): Resolver =>
  path => {
    const name = path.replace(/^\.\//, '')
    const text = files[name]

    return text === undefined
      ? undefined
      : { file: `${name}.tree`, text }
  }

// the private one, and a public task of the same file that uses it
const PRIV = `task is-given
  mark private
  take value, like text
  like boolean
  send back, true

task other
  take x, like text
  like boolean
  send back
    call is-given
      read x
`

// the public one as a native binding, in a file whose closure reaches the private task
const PUB_BIND = `load ./priv
  find other

bind is-given
  take value, like dynamic
  like boolean
  case node
    text <($value !== undefined && $value !== null)>

task also
  take x, like text
  like boolean
  send back, other(x)
`

// the public one as a task
const PUB_TASK = `load ./priv
  find other

task is-given
  take value, like text
  like boolean
  send back, false

task also
  take x, like text
  like boolean
  send back, other(x)
`

const CALL = `task run
  take x, like text
  like boolean
  send back
    call is-given
      read x
`

// the entry finds the public one, and reaches the private one only through `pub`
const THROUGH = `load ./pub
  find is-given
  find also

${CALL}`

// the entry also loads the private one's file itself, for another name
const BESIDE = `load ./pub
  find is-given

load ./priv
  find other

${CALL}`

for (const [kind, pub] of [
  ['binding', PUB_BIND],
  ['task', PUB_TASK],
] as const) {
  for (const [how, entry] of [
    ['through pub', THROUGH],
    ['beside priv', BESIDE],
  ] as const) {
    const resolve = resolverOf({ priv: PRIV, pub })
    const merged = compile(
      { file: 'entry.tree', text: entry },
      { resolve, cache: new CompileCache() },
    ) as Built
    const separate = compileSeparate(
      { file: 'entry.tree', text: entry },
      { resolve, cache: new CompileCache(), modules: slug },
    ) as Built

    ok(
      `${kind}, ${how}: the merged build finds the public is-given`,
      merged.ok,
      said(merged),
    )
    ok(
      `${kind}, ${how}: the separate build finds the public is-given`,
      separate.ok,
      said(separate),
    )

    if (kind === 'binding') {
      // the entry's call is the binding's inline text, never a call of the private task
      ok(
        `${kind}, ${how}: the merged entry calls the binding`,
        merged.ok &&
          /!== undefined && .* !== null/.test(merged.typescript ?? ''),
        merged.typescript ?? '',
      )
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
