// The page contract, split from the dom (native-dom-0003): the document shell, route path, title, meta, proxy and
// navigation live in `@term/site/code/dom/page`, and the dom is the node contract alone. Each env reaches its own page:
// the browser sets the live document, node and cloudflare stash into the SSR shell (cloudflare would otherwise borrow
// the browser's, which reads a document a Worker does not have), and an env with no page of its own gets the no-op
// fallback beside the env dirs. The dom no longer answers for a page task, so a host that only builds nodes (the
// toolkit views, the in-memory tree) implements nothing it cannot honor.
// Run: npx tsx test/compile/page-contract.ts

import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
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

const TERM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FILE = path.join(TERM, 'test/compile/page-contract.tree')

const PAGE = `load @term/site/code/dom/page
  find set-title
  find set-meta
  find page-path
  find proxy-target

task visit
  like text
  call set-title
    text <Home>
  call set-meta
    text <description>
    text <The home page>
  call proxy-target
  send back
    call page-path
`

const build = (env: string, text: string) => compile({ file: FILE, text }, { resolve: projectResolver(TERM, env) })

const reasons = (result: ReturnType<typeof build>) =>
  result.ok ? '' : result.diagnostics.slice(0, 3).map(d => d.message).join(' | ')

// the body of the emitted `setTitle`, which is what tells one env's page from another's
const bodyOf = (typescript: string, name: string) => {
  const at = typescript.search(new RegExp(`function ${name}\\(`))
  return at < 0 ? '' : typescript.slice(at, typescript.indexOf('\n}', at))
}

const browser = build('browser', PAGE)
ok('the page compiles for the browser', browser.ok, reasons(browser))
ok('the browser sets the live document title', bodyOf(browser.typescript ?? '', 'setTitle').includes('title.set('), bodyOf(browser.typescript ?? '', 'setTitle'))

const node = build('node', PAGE)
ok('the page compiles for node', node.ok, reasons(node))
ok('node stashes the title for the SSR shell', bodyOf(node.typescript ?? '', 'setTitle').includes('doc.setTitle('), bodyOf(node.typescript ?? '', 'setTitle'))

const cloudflare = build('cloudflare', PAGE)
ok('the page compiles for cloudflare', cloudflare.ok, reasons(cloudflare))
ok(
  "cloudflare stashes like node, not the browser's live document",
  bodyOf(cloudflare.typescript ?? '', 'setTitle').includes('doc.setTitle(') && !(cloudflare.typescript ?? '').includes('title.set('),
  bodyOf(cloudflare.typescript ?? '', 'setTitle'),
)

// `javascript` has no page of its own and no fallback env: it reaches the abstract module, whose tasks are no-ops
const bare = build('javascript', PAGE)
ok('the page compiles for an env with no page of its own', bare.ok, reasons(bare))
ok(
  'that env gets the no-op fallback, touching neither a document nor a shell',
  bodyOf(bare.typescript ?? '', 'setTitle').startsWith('function setTitle(') &&
    !/doc\.|title\.set/.test(bodyOf(bare.typescript ?? '', 'setTitle')),
  bodyOf(bare.typescript ?? '', 'setTitle'),
)

// the dom is the node contract now: a page task is not one of its names
for (const env of ['browser', 'node']) {
  const fromDom = build(
    env,
    `load @term/site/code/dom/dom
  find set-title

task visit
  call set-title
    text <Home>
`,
  )
  ok(
    `the dom no longer answers for set-title on ${env}`,
    !fromDom.ok && fromDom.diagnostics.some(d => d.message.includes('set-title')),
    fromDom.ok ? 'it compiled' : reasons(fromDom),
  )
}

// what stays in the dom: the root to mount into and a listener on it, which every host implements
const node2 = build(
  'node',
  `load @term/site/code/dom/dom
  find view
  find page-body
  find listen-document

task mount
  like view
  send back
    call page-body
`,
)
ok('page-body and listen-document stay in the dom', node2.ok, reasons(node2))

console.log(`\npage-contract: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
