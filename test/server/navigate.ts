// Cmd+click, against real files of the repository: `textDocument/definition` on a name, a type, a `find`, and the
// path of a `load` / `bear` / manifest `link`, and `textDocument/documentLink` for every path. Every path goes
// through the server's one `resolveModule`, which asks the resolver the compiler uses.
// Run: npx tsx test/server/navigate.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LanguageServer } from '@term/flow/code/server'

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

type Range = { start: { line: number; character: number }; end: { line: number; character: number } }
type Location = { uri: string; range: Range }

const term = process.cwd()
const server = new LanguageServer()
let id = 1

async function openFile(rel: string, text?: string): Promise<{ uri: string; text: string }> {
  const file = join(term, rel)
  const uri = pathToFileURL(file).href
  const body = text ?? readFileSync(file, 'utf8')
  await server.dispatch({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, text: body, version: 1 } } })

  return { uri, text: body }
}

// the position of `needle` on the first line holding `line`, `offset` characters into the needle
function at(text: string, line: string | number, needle: string, offset = 1): { line: number; character: number } {
  const lines = text.split('\n')
  const n = typeof line === 'number' ? line : lines.findIndex(l => l.includes(line))

  return { line: n, character: lines[n]!.indexOf(needle) + offset }
}

async function definition(uri: string, position: { line: number; character: number }): Promise<Location | null> {
  const out = await server.dispatch({ jsonrpc: '2.0', id: id++, method: 'textDocument/definition', params: { textDocument: { uri }, position } })
  const answer = out.find(m => m.id === id - 1)!

  if (answer.error) {
    return { uri: `error ${answer.error.message}`, range: { start: { line: -1, character: 0 }, end: { line: -1, character: 0 } } }
  }

  return answer.result as Location | null
}

// the text of the line a location points at
function lineAt(location: Location | null): string {
  if (!location || !location.uri.startsWith('file:')) {
    return ''
  }

  return readFileSync(fileURLToPath(location.uri), 'utf8').split('\n')[location.range.start.line] ?? ''
}

const ends = (location: Location | null, suffix: string): boolean => !!location && location.uri.endsWith(suffix)

// ---- 1. names, across files, through load / find ----
{
  const halt = await openFile('deck/call/code/work/halt.tree')

  const lean = await definition(halt.uri, at(halt.text, 'log-good <Nothing to stop>', 'log-good'))
  ok('name: a bare lean call goes to its task in the module that exports it', ends(lean, 'work/tint.tree') && /log-good/.test(lineAt(lean)), JSON.stringify(lean))

  const form = await definition(halt.uri, at(halt.text, 'make run-ask', 'run-ask'))
  ok('name: a `make` form goes to its `form` in this file', form?.uri === halt.uri && halt.text.split('\n')[form!.range.start.line]!.startsWith('form run-ask'), JSON.stringify(form))

  const own = await definition(halt.uri, at(halt.text, 'call first-number', 'first-number'))
  ok('name: a call of a task in this file goes to it', own?.uri === halt.uri && halt.text.split('\n')[own!.range.start.line]!.startsWith('task first-number'), JSON.stringify(own))

  const list = await openFile('deck/base/code/list.tree')
  const like = await definition(list.uri, at(list.text, 552, 'ordering'))
  ok('name: a type after `like` goes to its `form` in the loaded module', ends(like, 'base/code/ordering.tree') && /ordering/.test(lineAt(like)), JSON.stringify(like))

  const keyword = await definition(halt.uri, at(halt.text, 'call first-number', 'call'))
  ok('name: `call` itself is no definition of its own (the call it heads is)', keyword === null || /first-number/.test(halt.text.split('\n')[keyword.range.start.line] ?? lineAt(keyword)), JSON.stringify(keyword))
}

// ---- 2. the path of a load ----
{
  const halt = await openFile('deck/call/code/work/halt.tree')
  const tint = await definition(halt.uri, at(halt.text, 'load @term/call/code/work/tint', 'work/tint'))
  ok('path: a package path opens the module, line 1', ends(tint, 'deck/call/code/work/tint.tree') && tint!.range.start.line === 0, JSON.stringify(tint))

  const text = await definition(halt.uri, at(halt.text, 'load @term/base/code/text', '@term'))
  ok('path: a stdlib path opens the stdlib module', ends(text, 'deck/base/code/text.tree'), JSON.stringify(text))

  const time = await openFile('deck/base/code/time.tree')
  const native = await definition(time.uri, at(time.text, '{platform}/time', '{platform}', 2))
  ok('path: a `{platform}` path opens the node implementation', ends(native, 'deck/base/code/native/node/time.tree'), JSON.stringify(native))

  const risk = await openFile('deck/mill/code/code/task/mine.tree')
  const relative = await definition(risk.uri, at(risk.text, 'load ./risk/mine', './risk'))
  ok('path: a relative path opens the file beside it', ends(relative, 'deck/mill/code/code/task/risk/mine.tree') && relative!.range.start.line === 0, JSON.stringify(relative))
}

// ---- 3. a `find` under a load ----
{
  const halt = await openFile('deck/call/code/work/halt.tree')
  const found = await definition(halt.uri, at(halt.text, '  find log-step', 'log-step'))
  ok('find: goes to the name in the module the load opens', ends(found, 'work/tint.tree') && /log-step/.test(lineAt(found)), JSON.stringify(found))

  const split = await definition(halt.uri, at(halt.text, '  find split', 'split'))
  ok('find: in a stdlib module', ends(split, 'deck/base/code/text.tree') && /split/.test(lineAt(split)), JSON.stringify(split))
}

// ---- 4. a path that does not resolve ----
{
  const broken = 'load @term/base/code/no-such-module\n  find nothing-at-all\n\nload ./not-here\n\ntask f\n  like number\n  send back, code 1\n'
  const doc = await openFile('deck/base/code/zz-navigate-probe.tree', broken)
  const missing = await definition(doc.uri, at(broken, 'no-such-module', 'no-such'))
  ok('unresolved: a package path that names nothing answers null', missing === null, JSON.stringify(missing))

  const relative = await definition(doc.uri, at(broken, 'load ./not-here', './not'))
  ok('unresolved: a relative path that names nothing answers null', relative === null, JSON.stringify(relative))

  const find = await definition(doc.uri, at(broken, 'find nothing-at-all', 'nothing'))
  ok('unresolved: a `find` under it answers null, never a same-named word elsewhere', find === null, JSON.stringify(find))

  const links = (await server.dispatch({ jsonrpc: '2.0', id: id++, method: 'textDocument/documentLink', params: { textDocument: { uri: doc.uri } } }))[0]!.result as unknown[]
  ok('unresolved: no link for a path that names nothing', Array.isArray(links) && links.length === 0, JSON.stringify(links))
}

// ---- 5. mill definitions and manifests ----
{
  const mine = await openFile('deck/mill/code/code/fork/mine.tree')
  const path = await definition(mine.uri, at(mine.text, 'load @term/mill/code/code/form/link/mine', 'form/link'))
  ok('mill: a grammar `load` path opens the grammar file', ends(path, 'deck/mill/code/code/form/link/mine.tree') && path!.range.start.line === 0, JSON.stringify(path))

  const find = await definition(mine.uri, at(mine.text, '  find link', 'link'))
  ok('mill: a `find` goes to the rule in that grammar file', ends(find, 'form/link/mine.tree') && lineAt(find).split(' ').slice(0, 2).join(' ') === 'mine link', JSON.stringify(find))

  const rule = await definition(mine.uri, at(mine.text, 'mine form, like fork-test', 'fork-test'))
  ok('mill: a rule named after `like` goes to its `mine` rule in this file', rule?.uri === mine.uri && mine.text.split('\n')[rule!.range.start.line]!.startsWith('mine fork-test'), JSON.stringify(rule))

  const seed = await definition(mine.uri, at(mine.text, 'mine form, like seed', 'seed'))
  ok('mill: a rule a loaded grammar file declares goes there', ends(seed, 'code/seed/mine.tree') && lineAt(seed).split(' ').slice(0, 2).join(' ') === 'mine seed', JSON.stringify(seed))

  const base = await openFile('deck/mill/code/code/fork/base.tree')
  const nested = await definition(base.uri, at(base.text, 'bind mine, load ./mine', './mine'))
  ok('mill: the nested `load ./mine` of a dialect\'s base.tree opens its mine.tree', ends(nested, 'code/fork/mine.tree'), JSON.stringify(nested))

  const links = (await server.dispatch({ jsonrpc: '2.0', id: id++, method: 'textDocument/documentLink', params: { textDocument: { uri: base.uri } } }))[0]!.result as { target: string }[]
  ok('mill: base.tree links both its grammar files', links.length === 2 && links.some(l => l.target.endsWith('fork/mine.tree')) && links.some(l => l.target.endsWith('fork/mint.tree')), JSON.stringify(links))

  const manifest = await openFile('deck/base/deck.tree')
  const bear = await definition(manifest.uri, at(manifest.text, 'bear ./code', './code'))
  ok('manifest: `bear ./code` opens the folder\'s entry file', !!bear && bear.uri.startsWith(pathToFileURL(join(term, 'deck/base/code')).href) && bear.range.start.line === 0, JSON.stringify(bear))

  const site = await openFile('deck/site/deck.tree')
  const link = await definition(site.uri, at(site.text, 'link @term/base', '@term/base'))
  ok('manifest: `link @term/base` opens the package\'s entry file', !!link && link.uri.startsWith(pathToFileURL(join(term, 'deck/base')).href), JSON.stringify(link))

  const siteLinks = (await server.dispatch({ jsonrpc: '2.0', id: id++, method: 'textDocument/documentLink', params: { textDocument: { uri: site.uri } } }))[0]!.result as { target: string }[]
  ok('manifest: its links resolve where the compiler resolves them', siteLinks.some(l => l.target.startsWith(pathToFileURL(join(term, 'deck/base')).href)), JSON.stringify(siteLinks))
}

// ---- links in a code file ----
{
  const halt = await openFile('deck/call/code/work/halt.tree')
  const links = (await server.dispatch({ jsonrpc: '2.0', id: id++, method: 'textDocument/documentLink', params: { textDocument: { uri: halt.uri } } }))[0]!.result as { range: Range; target: string }[]
  const first = halt.text.split('\n')[0]!
  ok(
    'links: every resolvable `load` path is a link, ranged on the path alone',
    links.length === 2 &&
      links[0]!.range.start.line === 0 &&
      links[0]!.range.start.character === first.indexOf('@') &&
      links[0]!.range.end.character === first.length &&
      links[0]!.target.endsWith('work/tint.tree'),
    JSON.stringify(links),
  )
}

console.log(`\nserver/navigate: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
