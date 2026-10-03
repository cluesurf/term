// `mark tag, name kind`: a union chooses the field its TypeScript type and values discriminate on, so a port keeps
// the shape the TypeScript it replaces declared (the checker's `Type` and the parser's nodes tag on `kind`).
// self-hosting-0020. The type, a construction with fields, a field-less construction, and a `fork case` over it,
// each emitted AND run. An untagged union is held to `form`, so nothing else moves.
// Run: npx tsx test/compile/union-tag.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'

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

const text = `form shape
  mark tag, name kind
  case circle
    link radius, like number
  case square
    link side, like number
  case point

form color
  case red
  case green

task make-circle
  take r, like number
  like shape
  send back
    make circle
      bind radius, read r

task make-point
  like shape
  send back, make point

task area
  take s, like shape
  like number
  fork case, read s
    case circle
      send back
        call multiply
          read radius
          read radius
    case square
      send back
        call multiply
          read side
          read side
    case point
      send back, code 0

task color-name
  take c, like color
  like text
  fork case, read c
    case red
      send back, text <red>
    case green
      send back, text <green>

task make-green
  like color
  send back, make green
`

const out = compile({ file: '/gate/code/union-tag.tree', text })
ok('it compiles', out.ok, out.ok ? '' : out.diagnostics.map(d => d.message).join(' | '))
const ts = out.ok ? out.typescript : ''

ok('the tagged union discriminates on kind', /\| \{ kind: "circle"; radius: number \}/.test(ts) && /\| \{ kind: "point" \}/.test(ts), ts.slice(ts.indexOf('type Shape'), ts.indexOf('type Shape') + 160))
ok('the untagged union still discriminates on form', /\| \{ form: "red" \}/.test(ts), ts.slice(ts.indexOf('type Color'), ts.indexOf('type Color') + 80))
ok('a construction writes kind', /\{ kind: "circle", radius: r \}/.test(ts), ts.slice(ts.indexOf('function makeCircle')))
ok('a field-less constant writes kind', /Object\.freeze\(\{ kind: "point" as const \}\)/.test(ts))
ok('the match tests kind', /\.kind === "circle"/.test(ts) && !/s\.form === "circle"/.test(ts))
ok('the untagged match tests form', /\.form === "red"/.test(ts))

if (out.ok) {
  const dir = mkdtempSync(join(tmpdir(), 'term-union-tag-'))
  const file = join(dir, 'union-tag.ts')
  writeFileSync(file, ts)
  const m = (await import(pathToFileURL(file).href)) as Record<string, (...args: unknown[]) => unknown>

  ok('a built circle carries kind', JSON.stringify(m.makeCircle!(3)) === '{"kind":"circle","radius":3}', JSON.stringify(m.makeCircle!(3)))
  ok('a built point carries kind', JSON.stringify(m.makePoint!()) === '{"kind":"point"}', JSON.stringify(m.makePoint!()))
  ok('the match reads a built value', m.area!(m.makeCircle!(3)) === 9 && m.area!(m.makePoint!()) === 0)
  ok('the match reads a value built by TypeScript in the declared shape', m.area!({ kind: 'square', side: 4 }) === 16)
  ok('the untagged union runs as before', m.colorName!(m.makeGreen!()) === 'green')
}

console.log(`\nunion-tag: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
