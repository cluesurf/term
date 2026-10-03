// The view vocabulary's words as face components (view-vocabulary-0004, note/term/view/11-vocabulary.md): every word
// face did not have before (text, stack, image, spacer, divider, frame, scroll) placed in one page, rendered against the
// in-memory dom on TypeScript, and the tree read back. Each word must draw the element and the style words the
// vocabulary says, and a component's children must sit directly inside it, never under a `seed-fragment`.
// Run: npx tsx test/view/vocabulary.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'

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

const PROGRAM = `load @term/site/code/dom/native/memory/dom
  find view
  find create-element
  find serialize

load @term/face/code/component/stack
  find stack
load @term/face/code/component/text
  find text
load @term/face/code/component/spacer
  find spacer
load @term/face/code/component/divider
  find divider
load @term/face/code/component/image
  find image
load @term/face/code/component/frame
  find frame
load @term/face/code/component/scroll
  find scroll

view page
  take host, like view
  view stack
    bind direction, text <row>
    bind gap, code 12
    bind align, text <center>
    bind justify, text <between>
    view text
      bind content, text <Title>
      bind level, code 1
    view text
      bind content, text <Home>
      bind link, text </home>
    view text
      bind content, text <plain>
    view spacer
    view divider
    view image
      bind source, text <a.png>
      bind text, text <A dot>
      bind fit, text <cover>
    view frame
      bind width, code 200
      bind max-height, code 50
      view text
        bind content, text <framed>
    view scroll
      view text
        bind content, text <inside>

task run
  like text
  save root
    call create-element
      text <main>
  call page
    read root
  send back
    call serialize
      read root
`

const ROOT = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-vocabulary-'))
const entry = join(dir, 'page.tree')
writeFileSync(entry, PROGRAM)

// the dom is the memory host, so the tree can be read back
const base = projectResolver(ROOT, 'node')
const resolve = (importPath: string, fromFile: string) =>
  base(importPath.replace(/dom\/native\/\{platform\}\/dom$/, 'dom/native/memory/dom'), fromFile)
const result = compile({ file: entry, text: PROGRAM }, { resolve, env: 'node' })
ok('a page placing every new word compiles', result.ok, result.ok ? '' : result.diagnostics.slice(0, 4).map(d => d.message).join(' | '))

if (result.ok) {
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const prelude = nativePrelude(result.program, 'node', readRuntime, result.typescript)
  const file = join(dir, 'page.ts')
  writeFileSync(file, `${prelude}\n${result.typescript}\nconsole.log(run())\n`)
  const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  const tree = ran.stdout.trim()
  const has = (part: string) => tree.includes(part)

  ok('it runs', ran.status === 0, ran.stderr.slice(0, 600))
  ok(
    'stack: a flex div with the layout model as style words',
    has('data-slot="stack"') &&
      has('flex-direction: row') &&
      has('gap: 12px') &&
      has('align-items: center') &&
      has('justify-content: space-between'),
    tree.slice(0, 400),
  )
  ok('text with level 1 is an h1', /<h1 data-slot="text">Title<\/h1>/.test(tree), tree)
  ok('text with a link is an a with its href', /<a data-slot="text" href="\/home">Home<\/a>/.test(tree), tree)
  ok('text with neither is a span', /<span data-slot="text">plain<\/span>/.test(tree), tree)
  ok('spacer is a div that grows, out of the accessibility tree', /<div data-slot="spacer" style="flex-grow: 1" aria-hidden="true"><\/div>/.test(tree), tree)
  ok('divider is an hr', /<hr data-slot="divider"><\/hr>/.test(tree), tree)
  ok(
    'image is an img with its source, its words and its fit',
    has('<img data-slot="image"') && has('src="a.png"') && has('alt="A dot"') && has('object-fit: cover'),
    tree,
  )
  ok(
    'frame sets only the bounds it was given',
    has('data-slot="frame"') && has('width: 200px; ') && has('max-height: 50px; ') && !has('min-width'),
    tree,
  )
  ok('frame holds its child directly', /data-slot="frame"[^>]*><span data-slot="text">framed<\/span><\/div>/.test(tree), tree)
  ok(
    'scroll is a scroll element that overflows on its own',
    /<scroll data-slot="scroll" style="display: block; overflow-y: auto"><span data-slot="text">inside<\/span><\/scroll>/.test(tree),
    tree,
  )
  ok('no seed-fragment sits between a component and its children', !has('seed-fragment'), tree)
}

console.log(`\nvocabulary: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
