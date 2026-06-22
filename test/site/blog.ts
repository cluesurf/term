// End-to-end blog app: compile the `.tree` blog (render runtime + the browser DOM via @cluesurf/bind) to JS, bundle
// it, and run it headless against a DOM stub. Asserts the app mounts its form + empty list, then that clicking "Add
// post" reads the inputs, renders a post (heading + body) into the list, and clears the inputs — and that a second
// post appends without disturbing the first. Also emits the runnable browser artifacts. Run: npx tsx test/site/blog.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import { projectResolver } from '@cluesurf/call/code/make'
import { build } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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

// the seed package (where `seed link` puts the @cluesurf/* symlinks) and the deck root (where the packages live)
const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

const DECK = path.resolve(SEED, '..')
// resolve through the seed package manager: @cluesurf/site, /bind, /base via the linked packages, and the abstract
// dom API rewritten to the browser native impl by the `browser` env. No hand-written resolver.
const resolve = projectResolver(SEED, 'browser')

// a minimal DOM stub. Inputs carry a `value`; get-value/set-value read and write it. Elements support the subset the
// render runtime + bind use: setAttribute, appendChild, addEventListener, replaceWith, textContent, value.
function makeStubElement(tag: string): any {
  return {
    tagName: tag,
    parent: null as any,
    children: [] as any[],
    attributes: {} as Record<string, string>,
    listeners: {} as Record<string, (() => void)[]>,
    textContent: '',
    value: '',
    setAttribute(n: string, v: string) {
      this.attributes[n] = v
    },
    appendChild(c: any) {
      c.parent = this
      this.children.push(c)

      return c
    },
    addEventListener(e: string, h: () => void) {
      ;(this.listeners[e] ??= []).push(h)
    },
    replaceWith(n: any) {
      void n
    },
    // ChildNode.remove(): detach from the parent. The reactive `each` uses it to reconcile the list on every change.
    remove() {
      const siblings = this.parent?.children

      if (siblings) {
        const i = siblings.indexOf(this)

        if (i >= 0) {siblings.splice(i, 1)}
      }

      this.parent = null
    },
    fire(e: string) {
      for (const h of this.listeners[e] ?? []) {h()}
    },
  }
}

// the rendered text of a post node (its first text-child's content)
function textOf(node: any): string {
  return node?.children?.[0]?.textContent ?? ''
}

async function main(): Promise<void> {
  const entry = path.join(
    DECK,
    'seed/deck/site/test/site/face/blog.tree',
  )

  const result = compile(
    { file: entry, text: fs.readFileSync(entry, 'utf8') },
    { resolve },
  )

  ok(
    'blog compiles against the browser DOM (bind)',
    result.ok,
    result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)),
  )

  if (!result.ok) {
    console.log(`\nblog: ${pass} pass, ${fail} fail`)

    return
  }

  ok(
    'emits native createElement/appendChild',
    /\.createElement\(/.test(result.typescript) &&
      /\.appendChild\(/.test(result.typescript),
  )
  ok(
    'does not shadow the document global',
    !/const document = \w/.test(result.typescript),
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-blog-'))
  fs.writeFileSync(path.join(dir, 'app.ts'), result.typescript)
  fs.writeFileSync(
    path.join(dir, 'entry.ts'),
    `import { blog } from './app'\nblog({ handle: document.body })\n`,
  )

  const bundled = await build({
    entryPoints: [path.join(dir, 'entry.ts')],
    bundle: true,
    format: 'esm',
    write: false,
  })

  const code = bundled.outputFiles[0].text
  ok('bundles to a single browser module', code.length > 0)

  const body = makeStubElement('body')

  ;(globalThis as any).document = {
    createElement: (tag: string) => makeStubElement(tag),
    createTextNode: (v: string) => {
      const n = makeStubElement('')
      n.textContent = v

      return n
    },
    body,
  }

  const file = path.join(dir, 'bundle.mjs')
  fs.writeFileSync(file, code)
  await import(file)

  // the mounted page: <div><input><textarea><button>Add post</button><div posts/></div>
  const root = body.children[0]
  ok('mounts a root element', root?.tagName === 'div')

  const [titleInput, bodyInput, addButton, posts] = root?.children ?? []
  ok('renders a title input', titleInput?.tagName === 'input')
  ok('renders a body textarea', bodyInput?.tagName === 'textarea')
  ok(
    'renders an Add button',
    addButton?.tagName === 'button' && textOf(addButton) === 'Add post',
  )
  ok(
    'post list starts empty',
    posts?.tagName === 'div' && posts.children.length === 0,
  )

  // create the first post
  titleInput.value = 'First Post'
  bodyInput.value = 'Hello world'
  addButton.fire('click')
  ok('one post after adding', posts.children.length === 1)

  const post1 = posts.children[0]
  ok(
    'post renders heading + body',
    post1?.children?.[0]?.tagName === 'h2' &&
      post1?.children?.[1]?.tagName === 'p',
  )
  ok(
    'post heading is the title',
    textOf(post1.children[0]) === 'First Post',
    JSON.stringify(textOf(post1?.children?.[0])),
  )
  ok(
    'post body is the content',
    textOf(post1.children[1]) === 'Hello world',
    JSON.stringify(textOf(post1?.children?.[1])),
  )
  ok(
    'inputs cleared after adding',
    titleInput.value === '' && bodyInput.value === '',
  )

  // create a second post; the first must remain
  titleInput.value = 'Second Post'
  bodyInput.value = 'More text'
  addButton.fire('click')
  ok('two posts after adding again', posts.children.length === 2)
  ok(
    'first post unchanged',
    textOf(posts.children[0].children[0]) === 'First Post',
  )
  ok(
    'second post rendered',
    textOf(posts.children[1].children[0]) === 'Second Post' &&
      textOf(posts.children[1].children[1]) === 'More text',
  )

  // emit runnable artifacts
  const web = path.join(DECK, 'seed/deck/site/host/web-blog')
  fs.mkdirSync(web, { recursive: true })
  fs.writeFileSync(path.join(web, 'app.js'), code)
  fs.writeFileSync(
    path.join(web, 'index.html'),
    `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>Seed blog</title></head>\n  <body>\n    <script type="module" src="./app.js"></script>\n  </body>\n</html>\n`,
  )
  ok(
    'emits browser artifacts (index.html + app.js)',
    fs.existsSync(path.join(web, 'index.html')),
  )

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\nblog: ${pass} pass, ${fail} fail`)
}

void main()
