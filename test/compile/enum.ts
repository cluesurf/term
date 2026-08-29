// Enum + match tests: discriminated-union emit, tagged construction, exhaustiveness, and running it.
// Run: npx tsx test/compile/enum.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { render } from '@term/make/code/parser/diagnostic'

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

// an enum, a constructor, and an exhaustive match
const EXHAUSTIVE = `form color
  case red
  case green
  case blue

task name-of
  take c, like color
  like text
  fork case, read c
    case red
      send back, text <red>
    case green
      send back, text <green>
    case blue
      send back, text <blue>

task run
  send back
    call name-of
      make green
`

// the same match, missing the `blue` case
const NON_EXHAUSTIVE = `form color
  case red
  case green
  case blue

task name-of
  take c, like color
  like text
  fork case, read c
    case red
      send back, text <red>
    case green
      send back, text <green>
`

async function main(): Promise<void> {
  const result = compile({ file: 'enum.tree', text: EXHAUSTIVE })

  if (!result.ok) {
    for (const d of result.diagnostics)
      {console.log(render(d, EXHAUSTIVE.split('\n'), false))}

    console.log('\nenum: 0 pass, 1 fail')

    return
  }

  console.log('--- emitted TypeScript ---')
  console.log(result.typescript)
  ok(
    'emits discriminated union',
    result.typescript.includes('type Color ='),
  )
  ok('emits variant tag', result.typescript.includes('form: "green"'))
  ok(
    'emits match as form switch',
    result.typescript.includes('.form === "red"'),
  )

  // run it: name-of(green) === "green"
  const dir = mkdtempSync(join(tmpdir(), 'seed-enum-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)

  const mod = (await import(pathToFileURL(file).href)) as {
    run: () => string
  }

  ok('run() returns "green"', mod.run() === 'green', `got ${mod.run()}`)

  // exhaustiveness: the missing-case version is a compile error
  const bad = compile({ file: 'enum.tree', text: NON_EXHAUSTIVE })
  ok(
    'non-exhaustive match caught',
    !bad.ok && bad.diagnostics.some(d => d.name === 'non-exhaustive'),
    bad.ok
      ? 'compiled cleanly'
      : bad.diagnostics.map(d => d.name).join(','),
  )

  if (!bad.ok) {
    const d = bad.diagnostics.find(x => x.name === 'non-exhaustive')

    if (d) {console.log(`      (${d.message})`)}
  }

  // a literal index is a plain path segment, spelled with brackets on the way out
  const indexed = compile({
    file: 'i.tree',
    text: 'task first\n  take items, like list\n    like number\n  like number\n  send back, read items/0\n',
  })
  ok(
    'a literal index reads with brackets',
    indexed.ok && indexed.typescript.includes('return items[0]'),
  )

  // a `link` past the variant's last field binds nothing, so it is refused rather than silently ignored
  const strayLink = compile({
    file: 'l.tree',
    text: 'form shape\n  case dot\n    link x, like number\n  case line\n    link a, like number\n    link b, like number\n\ntask size\n  take s, like shape\n  like number\n  fork case, read s\n    case dot\n      link px\n      link py\n      send back, read px\n    case line\n      send back, read a\n',
  })
  ok(
    'a link past the last field is refused and names the fields',
    !strayLink.ok && strayLink.diagnostics.some(d => d.message.includes('"link py" under "case dot" binds nothing') && d.message.includes('(x)')),
    strayLink.ok ? 'compiled' : strayLink.diagnostics.map(d => d.message).join(' | '),
  )

  // the same arm with one rename is the ordinary rename form
  const rename = compile({
    file: 'r.tree',
    text: 'form shape\n  case dot\n    link x, like number\n  case line\n    link a, like number\n    link b, like number\n\ntask size\n  take s, like shape\n  like number\n  fork case, read s\n    case dot\n      link px\n      send back, read px\n    case line\n      send back, read a\n',
  })
  ok('a rename within the field count is accepted', rename.ok, rename.ok ? '' : rename.diagnostics.map(d => d.message).join(' | '))

  // `case full, like text` is a payload variant: its one value is the `value` field, so an arm reads it as `value` or
  // renames it with a link
  const payload = compile({
    file: 'p.tree',
    text: 'form box\n  case full, like text\n  case void\n\ntask open\n  take b, like box\n  like text\n  fork case, read b\n    case full, link content\n      send back, read content\n    case void\n      send back, text <empty>\n\ntask run\n  like text\n  send back\n    call open\n      make full\n        bind value, text <filled>\n',
  })
  ok(
    'a payload variant binds its value through a link',
    payload.ok && payload.typescript.includes('const content = b.value'),
    payload.ok ? payload.typescript.split('\n').filter(l => /content|value/.test(l)).join(' | ') : payload.diagnostics.map(d => d.message).join(' | '),
  )

  if (payload.ok) {
    const dir = mkdtempSync(join(tmpdir(), 'term-enum-'))
    const file = join(dir, 'module.ts')
    writeFileSync(file, payload.typescript)
    const mod = (await import(pathToFileURL(file).href)) as { run: () => string }
    ok('a payload variant runs', mod.run() === 'filled', String(mod.run()))
  }

  console.log(`\nenum: ${pass} pass, ${fail} fail`)
}

main()
