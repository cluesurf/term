// A template's holes are counted and may be typed (compile/template.ts): `take tag, like number` holds a number
// literal, `like text` a text, `like boolean` a flag, `like name` one word, and `fall <value>` fills a hole a fuse leaves
// out. A fuse that does not fit is refused AT THE FUSE: a hole left out, a value too many, a `bind` or a `beam` the
// template does not take, a value of the wrong kind, a template nothing defines. Before 2026-10-05 each of these
// expanded anyway, a missing hole as its own name, and what it broke was found far from the fuse, if at all.
// Run: npx tsx test/compile/template-holes.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

const built = (text: string) => compile({ file: 'holes.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!) })
const messages = (text: string): string => {
  const out = built(text)

  return out.ok ? '' : out.diagnostics.map(d => `${d.span.start.line}: ${d.message}`).join(' | ')
}

const TREE = `tree badge
  take name, like name
  take size, like number
  take label, like text
  take loud, like boolean, fall false
  hook fuse
    task badge-{name}
      like text
      fork test, {loud}
        hold
          back <{label} {size}!>
      back <{label} {size}>
`

const typed = built(`${TREE}
fuse badge, warn, 3, <careful>

fuse badge
  bind name, shout
  bind size, 9
  bind label, <hey>
  bind loud, true

task run
  like text
  back <{badge-warn()} / {badge-shout()}>
`)

ok('holes of each kind fill, and a hole with `fall` may be left out', typed.ok && /careful 3/.test(typed.typescript) && /hey 9!/.test(typed.typescript), typed.ok ? typed.typescript.slice(-400) : typed.diagnostics.map(d => d.message).join(' | '))

const missing = messages(`${TREE}
fuse badge, warn, 3
`)
// spans count lines from 0: the fuse is the file's fourteenth line
ok('a hole left out is refused at the fuse, naming it', /^13: `fuse badge` leaves out `label`, which the template takes/.test(missing) && !/`loud`/.test(missing), missing)

const extra = messages(`${TREE}
fuse badge, warn, 3, <careful>, true, more
`)
ok('a value too many is refused, with the count', /`fuse badge` gives 5 values in order, and the template takes 4/.test(extra), extra)

const unknown = messages(`${TREE}
fuse badge, warn, 3, <careful>
  bind colour, red
`)
ok('a `bind` the template does not take is refused, naming what it takes', /`fuse badge` binds `colour`, and the template takes `name`, `size`, `label`, `loud`/.test(unknown), unknown)

const kind = messages(`${TREE}
fuse badge, warn, big, <careful>
`)
ok('a value of the wrong kind is refused, naming the kind the hole takes', /`fuse badge` gives `size` a name, and the template takes a number there \(`take size, like number`\)/.test(kind), kind)

// with a task beside it, so the file is code: a file of nothing but `fuse` lines is data (compile/host.ts), which
// refuses an unknown fuse in its own words
const nothing = messages(`fuse nowhere, a

task run
  like number
  back 0
`)
ok('a fuse of a template nothing defines is refused', /`fuse nowhere` names no template/.test(nothing), nothing)

const site = messages(`tree record-of
  take name
  hook fuse
    form {name}
      site fields

fuse record-of
  bind name, spot
  beam feilds
    link x, like number
`)
ok('a `beam` naming no site is refused, naming the sites', /`fuse record-of` beams `feilds`, and the template has the sites `fields`/.test(site), site)

const untyped = built(`tree is-tag
  take name
  take tag
  hook fuse
    task is-{name}
      take value, like number
      like boolean
      back is-equal(value, code {tag})

fuse is-tag
  bind name, red
  bind tag, 0
`)
ok('an untyped hole holds any word or literal, as before', untyped.ok, untyped.ok ? '' : untyped.diagnostics.map(d => d.message).join(' | '))

console.log(`\ntemplate-holes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
