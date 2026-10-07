// The DOM lowering's accessibility, audited against the contract (native-accessibility-0002). Every vocabulary word is
// placed on the in-memory dom with the props that name it, the tree is read back as HTML, and each element's ROLE and
// NAME are computed from that markup the way a browser maps HTML to its accessibility tree: an explicit `role`, else
// `aria-hidden="true"` takes it out, else the element's implicit role (button, input by its type, select, img with and
// without text, hr, h1 to h6, a with an href); a name from `aria-label`, else `alt`, else `placeholder`, else its text.
//
// Two witnesses that must agree: the computed role is what this test EXPECTS for the case, and it must also appear in
// that word's DOM cell of the contract table (note/term/view/11-vocabulary.md, "Accessibility"), so the note and the
// markup cannot drift apart. Run: npx tsx test/view/accessibility.ts

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

load @term/site/code/view/reactive
  find make-signal

load @term/face/code/logic/disclosure
  find make-disclosure

load @term/face/code/logic/range
  find make-range

load @term/base/code/list
  find list
  find push

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
load @term/face/code/component/switch
  find switch
load @term/face/code/component/slider
  find slider
load @term/face/code/component/select
  find select
load @term/face/code/component/dialog
  find dialog

view still
  take host, like view
  view text
    bind content, text <plain>
  view text
    bind content, text <Title>
    bind level, code 2
  view text
    bind content, text <Home>
    bind link, text </home>
  view image
    bind source, text <a.png>
    bind text, text <A dot>
  view image
    bind source, text <b.png>
  view input
    bind placeholder, text <Your name>
  view button
    text <Save>
  view stack
    view text
      bind content, text <in a stack>
  view scroll
    view text
      bind content, text <in a scroll>
  view spacer
  view divider
  view frame
    bind width, code 100
    view text
      bind content, text <in a frame>

view dialog-body
  take host, like view
  view span
    text <Sure?>

task size-names
  like list
    like text
  save names
    make list
  call push
    bind list, read names
    bind item, text <small>
  call push
    bind list, read names
    bind item, text <large>
  send back, read names

task run
  like text
  save root
    call create-element
      text <main>
  call still
    read root
  call switch
    read root
    text <>
    call make-disclosure
      bind start, false
    text <Wi-Fi>
  call slider
    read root
    text <>
    call make-range
      bind start, code 40.0
    code 0.0
    code 100.0
    code 1.0
    text <Volume>
  call select
    read root
    text <>
    call make-signal
      bind value, text <small>
    call size-names
    text <Size>
  call dialog
    read root
    text <>
    call make-disclosure
      bind start, true
    text <Delete it?>
    read dialog-body
  send back
    call serialize
      read root
`

type Element = { tag: string; attributes: Map<string, string>; text: string }

// the elements of our own serializer's output, each with its attributes and the text directly and indirectly inside it
function elementsOf(html: string): Element[] {
  const elements: Element[] = []
  const open: Element[] = []
  const token = /<(\/?)([a-z][a-z0-9-]*)((?:\s+[a-z-]+="[^"]*")*)\s*>|([^<]+)/g

  for (const found of html.matchAll(token)) {
    if (found[4] !== undefined) {
      for (const holder of open) {
        holder.text += found[4]
      }
      continue
    }

    if (found[1] === '/') {
      open.pop()
      continue
    }

    const attributes = new Map([...found[3]!.matchAll(/([a-z-]+)="([^"]*)"/g)].map(a => [a[1]!, a[2]!]))
    const element: Element = { tag: found[2]!, attributes, text: '' }
    elements.push(element)
    open.push(element)
  }

  return elements
}

// the role a browser maps the element to: explicit, hidden, or implicit by tag
function roleOf(element: Element): string {
  const { tag, attributes } = element

  if (attributes.get('aria-hidden') === 'true') {
    return 'hidden'
  }

  if (attributes.get('role')) {
    return attributes.get('role')!
  }

  if (tag === 'button') {
    return 'button'
  }

  if (tag === 'input') {
    return attributes.get('type') === 'range' ? 'slider' : 'textbox'
  }

  if (tag === 'select') {
    return 'combobox'
  }

  if (tag === 'img') {
    return attributes.get('alt') ? 'img' : 'hidden'
  }

  if (tag === 'hr') {
    return 'separator'
  }

  if (/^h[1-6]$/.test(tag)) {
    return 'heading'
  }

  if (tag === 'a' && attributes.has('href')) {
    return 'link'
  }

  return 'none'
}

function nameOf(element: Element): string {
  return element.attributes.get('aria-label') || element.attributes.get('alt') || element.attributes.get('placeholder') || element.text.trim()
}

// the contract's DOM cell per word
const note = readFileSync(join(process.cwd(), '../../../../note/term/view/11-vocabulary.md'), 'utf8')
const table = note.slice(note.indexOf('## Accessibility'), note.indexOf('## The layout model'))
const domCell = new Map(
  table
    .split('\n')
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(cells => cells.length === 10)
    .map(cells => [cells[0]!, cells[1]!] as const),
)

// the cell allows this role: named in backticks, or `none` written as the cell's own word
const allows = (word: string, role: string): boolean => {
  const cell = domCell.get(word) ?? ''

  return role === 'none' ? /(^|[ (;])none\b/.test(cell) : cell.includes(`\`${role}\``)
}

type Case = { word: string; what: string; find: (e: Element) => boolean; role: string; name?: string }

const slot = (name: string) => (e: Element) => e.attributes.get('data-slot') === name

const CASES: Case[] = [
  { word: 'text', what: 'plain text', find: e => slot('text')(e) && e.text === 'plain', role: 'none' },
  { word: 'text', what: 'text with a level', find: e => e.tag === 'h2', role: 'heading', name: 'Title' },
  { word: 'text', what: 'text with a link', find: e => e.tag === 'a', role: 'link', name: 'Home' },
  { word: 'image', what: 'an image with words', find: e => e.tag === 'img' && e.attributes.get('src') === 'a.png', role: 'img', name: 'A dot' },
  { word: 'image', what: 'an image with none', find: e => e.tag === 'img' && e.attributes.get('src') === 'b.png', role: 'hidden' },
  { word: 'field', what: 'a field', find: e => e.tag === 'input' && e.attributes.get('type') !== 'range', role: 'textbox', name: 'Your name' },
  { word: 'button', what: 'a button', find: e => e.tag === 'button' && e.text === 'Save', role: 'button', name: 'Save' },
  { word: 'toggle', what: 'a toggle', find: slot('switch'), role: 'switch', name: 'Wi-Fi' },
  { word: 'range', what: 'a range', find: slot('slider'), role: 'slider', name: 'Volume' },
  { word: 'choice', what: 'a choice', find: slot('select'), role: 'combobox', name: 'Size' },
  { word: 'stack', what: 'a stack', find: slot('stack'), role: 'none' },
  { word: 'scroll', what: 'a scroll', find: slot('scroll'), role: 'none' },
  { word: 'spacer', what: 'a spacer', find: slot('spacer'), role: 'hidden' },
  { word: 'divider', what: 'a divider', find: slot('divider'), role: 'separator' },
  { word: 'frame', what: 'a frame', find: slot('frame'), role: 'none' },
  { word: 'dialog', what: 'a dialog', find: slot('dialog'), role: 'dialog', name: 'Delete it?' },
]

const dir = mkdtempSync(join(tmpdir(), 'term-accessibility-'))
const entry = join(dir, 'page.tree')
writeFileSync(entry, PROGRAM)

const base = projectResolver(process.cwd(), 'node')
const resolve = (importPath: string, fromFile: string) =>
  base(importPath.replace(/dom\/native\/\{platform\}\/(dom|view)$/, 'dom/native/memory/$1'), fromFile)
const result = compile({ file: entry, text: PROGRAM }, { resolve, env: 'node' })
ok('a page of every word compiles', result.ok, result.ok ? '' : [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | '))

if (result.ok) {
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const file = join(dir, 'page.ts')
  writeFileSync(file, `${nativePrelude(result.program, 'node', readRuntime, result.typescript)}\n${result.typescript}\nconsole.log(run())\n`)
  const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  ok('it runs', ran.status === 0, ran.stderr.slice(0, 600))

  const html = ran.stdout.trim()
  const elements = elementsOf(html)

  for (const one of CASES) {
    const element = elements.find(one.find)

    if (!element) {
      ok(`${one.what}: is drawn`, false, html.slice(0, 400))
      continue
    }

    const role = roleOf(element)
    ok(`${one.what}: role ${one.role}`, role === one.role, `${role} on <${element.tag}>`)
    ok(`${one.what}: the contract's ${one.word} row allows ${one.role}`, allows(one.word, one.role), domCell.get(one.word) ?? 'no row')

    if (one.name !== undefined) {
      ok(`${one.what}: named ${one.name}`, nameOf(element) === one.name, nameOf(element))
    }
  }

  // every control a person operates has a name: nothing a screen reader reaches is announced as just its role
  const unnamed = elements.filter(e => ['button', 'switch', 'slider', 'combobox', 'textbox', 'link', 'img', 'dialog', 'heading'].includes(roleOf(e)) && !nameOf(e))
  ok('no operable or announced element is unnamed', unnamed.length === 0, unnamed.map(e => `<${e.tag}>`).join(' '))
}

console.log(`\naccessibility: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
