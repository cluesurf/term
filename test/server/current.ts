// The language server against TODAY's language and today's protocol, driven through `dispatch` with the messages an
// editor sends. Each block names the defect it holds closed:
//
//   lean        a file whose role carries `mark lean` was never given the lean flag, and the CLI's lean files showed
//               false errors (halt.tree 4, wash.tree 18, lint.tree 17) from the editor's own per-definition pipeline,
//               where `term make` reports none
//   scope       `mark private` and binding by import were never checked (the editor ran its own pipeline)
//   placement   an error inside an imported module was drawn at its own line number in the importing file
//   tests       a `test` file was compiled raw, and its diagnostics landed where the rewrite had moved its lines
//   keywords    retired words and a wrong `walk` scaffold in completion
//   lint        lint findings were never diagnostics, and their fixes were computed again on every code action
//   pull        no `textDocument/diagnostic`
//   timing      no debounce, no settle before a request, a closed document's analysis still published
//   sync        only whole-document sync, and nothing checked UTF-16 columns past an emoji
//   robust      a malformed document or position answered by throwing, which took the process down
//   memory      a closed document's analyzer and diagnostics were never released
//   workspace   references and rename covered the open file only
//   features    folding, selection ranges, highlights, semantic token deltas, lean parameter hints, call hierarchy
//
// Run: npx tsx test/server/current.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LanguageServer } from '@term/flow/code/server'
import type { Message } from '@term/flow/code/protocol'
import type { Source } from '@term/make/code/compile/load'

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
type Diag = { range: Range; severity: number; message: string; code: number | string; source: string; data?: { name?: string } }

let nextId = 1

const request = async (server: LanguageServer, method: string, params: unknown): Promise<Message> => {
  const id = nextId++
  const out = await server.dispatch({ jsonrpc: '2.0', id, method, params })

  return out.find(m => m.id === id)!
}

const notify = (server: LanguageServer, method: string, params: unknown): Promise<Message[]> =>
  server.dispatch({ jsonrpc: '2.0', method, params })

const open = (server: LanguageServer, uri: string, text: string, version = 1): Promise<Message[]> =>
  notify(server, 'textDocument/didOpen', { textDocument: { uri, languageId: 'tree', version, text } })

const published = (out: Message[], uri: string): Diag[] | undefined =>
  (out.find(m => m.method === 'textDocument/publishDiagnostics' && (m.params as { uri: string }).uri === uri)?.params as
    | { diagnostics: Diag[] }
    | undefined)?.diagnostics

const errors = (ds: Diag[] | undefined): Diag[] => (ds ?? []).filter(d => d.severity === 1)

// apply LSP text edits to a text, last first
function applyEdits(text: string, edits: { range: Range; newText: string }[]): string {
  const lines = text.split('\n')
  const offset = (p: { line: number; character: number }): number =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character

  let out = text

  for (const edit of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
    out = out.slice(0, offset(edit.range.start)) + edit.newText + out.slice(offset(edit.range.end))
  }

  return out
}

const term = process.cwd()

// ---- lean ----
{
  // the real lean files of the CLI, under their package's own role.tree (`mark lean` on code/work/**)
  const server = new LanguageServer()

  for (const name of ['halt', 'wash', 'lint']) {
    const file = join(term, `deck/call/code/work/${name}.tree`)
    const uri = pathToFileURL(file).href
    const out = await open(server, uri, readFileSync(file, 'utf8'))
    const found = errors(published(out, uri))
    ok(`lean: ${name}.tree has no errors, as \`term make\` says`, found.length === 0, found.map(d => d.message).join(' | '))
  }

  // and an explicit lean reader: a bare head is a call, `back` returns
  const lean = new LanguageServer({ roleOf: () => 'code', leanOf: () => true })
  const LEAN = 'task twice\n  take n, like number\n\n  like number\n\n  back add(n, n)\n'
  const out = await open(lean, 'file:///virtual/lean.tree', LEAN)
  ok('lean: a lean task compiles clean under the lean reader', errors(published(out, 'file:///virtual/lean.tree')).length === 0, JSON.stringify(published(out, 'file:///virtual/lean.tree')))

  // a construct only the lean surface reads: a bare call with its arguments named by property heads, in the order
  // the author chose rather than the order declared. The CLI's own lean files are written in the subset that reads
  // the same both ways (role.tree says so, and `pnpm term:lean-equal` holds it), so they cannot show the flag at
  // work; this can.
  const NAMED =
    'task join-two\n  take left, like text\n  take right, like text\n\n  like text\n\n  back left\n\ntask use\n  like text\n\n  back\n    join-two\n      right <b>\n      left <a>\n'
  const outNamed = await open(lean, 'file:///virtual/named.tree', NAMED)
  ok('lean: named arguments by property head compile under the lean reader', errors(published(outNamed, 'file:///virtual/named.tree')).length === 0, JSON.stringify(published(outNamed, 'file:///virtual/named.tree')))

  const longhand = new LanguageServer({ roleOf: () => 'code', leanOf: () => false })
  const outLong = await open(longhand, 'file:///virtual/named.tree', NAMED)
  ok('lean: the same text read longhand is an error (the flag reaches the compile)', errors(published(outLong, 'file:///virtual/named.tree')).length > 0, JSON.stringify(published(outLong, 'file:///virtual/named.tree')))
}

// ---- roles: a mill definition is read as one, never as code ----
{
  // @term/mill's role.tree names `role mill` for code/**: these files DEFINE the fork dialect, and were milled as
  // code ("the name "mill" is not defined", over a thousand errors across the grammar files they load)
  const server = new LanguageServer()
  const fork = join(term, 'deck/mill/code/code/fork')

  for (const name of ['base', 'mine', 'mint']) {
    const file = join(fork, `${name}.tree`)
    const uri = pathToFileURL(file).href
    const out = await open(server, uri, readFileSync(file, 'utf8'))
    const found = published(out, uri) ?? []
    ok(`roles: fork/${name}.tree, a mill definition, has no diagnostics`, found.length === 0, found.slice(0, 3).map(d => d.message).join(' | '))
  }

  // the control: the same file with no role, which is what the server had before deck/mill/role.tree, is read as
  // code and fails, so the clean result above is the role at work
  const asCode = new LanguageServer({ roleOf: () => null, leanOf: () => false })
  const forkMine = pathToFileURL(join(fork, 'mine.tree')).href
  const outCode = await open(asCode, forkMine, readFileSync(join(fork, 'mine.tree'), 'utf8'))
  const codeErrors = errors(published(outCode, forkMine))
  // which error comes first is the code reader's business: an undefined name, or since 2026-10-05 the `fuse hook`
  // the grammar it loads writes, refused at the fuse as a template given too little (compile/template.ts)
  ok(
    'roles: read as code instead, fork/mine.tree fails (the defect the role closes)',
    codeErrors.length > 0 && codeErrors.some(d => /is not defined|leaves out/.test(d.message)),
    JSON.stringify(codeErrors.slice(0, 2)),
  )

  // the same file with a `find` of a rule its target does not declare: the real problem, on the line it is on,
  // as the mill gate words it, and nothing a code reading would have said
  const mine = join(fork, 'mine.tree')
  const mineUri = pathToFileURL(mine).href
  const broken = readFileSync(mine, 'utf8').replace('  find link\n', '  find link\n  find no-such-rule\n')
  const out = await open(server, mineUri, broken, 2)
  const found = published(out, mineUri) ?? []
  const line = broken.split('\n').findIndex(l => l.includes('no-such-rule'))
  ok(
    'roles: a broken mill definition reports its real error, on its line',
    found.length === 1 && found[0]!.range.start.line === line && found[0]!.message.includes('no-such-rule'),
    JSON.stringify(found),
  )
  ok('roles: and no code-reading error with it', !found.some(d => /is not defined/.test(d.message)))

  const unloadable = readFileSync(mine, 'utf8').replace(
    'load @term/mill/code/seed/mine',
    'load @term/mill/code/no-such-dialect/mine',
  )
  const outLoad = await open(server, mineUri, unloadable, 3)
  const loadFound = published(outLoad, mineUri) ?? []
  ok(
    'roles: a load of a grammar file that does not exist is reported on the load',
    loadFound.some(d => d.message.includes('no-such-dialect') && d.range.start.line === unloadable.split('\n').findIndex(l => l.includes('no-such-dialect'))),
    JSON.stringify(loadFound),
  )

  const unparsed = await open(server, mineUri, 'mine fork\n  mine term, term <fork\n', 4)
  ok('roles: a mill definition that does not parse reports the parse error', (published(unparsed, mineUri) ?? []).length > 0)
}

// ---- scope: mark private, binding by import ----
{
  const modules: Record<string, string> = {
    '@app/a':
      'task secret\n  mark private\n  like text\n  send back, text <s>\n\ntask open-one\n  like text\n  send back\n    call secret\n',
    '@app/pick-text': 'task pick\n  take x, like text\n  like text\n  send back, text <text>\n',
    '@app/pick-number':
      'task pick\n  take x, like number\n  like text\n  send back, text <number>\n\ntask other\n  like text\n  send back, text <o>\n',
    '@app/broken': 'task broken\n  like number\n  send back, text <not a number>\n',
  }
  const resolve = (path: string): Source | undefined =>
    modules[path] !== undefined ? { file: `/virtual/${path.slice(5)}.tree`, text: modules[path]! } : undefined

  const server = new LanguageServer({ resolve })

  const usesPrivate = 'load @app/a\n  find secret\n\ntask run\n  like text\n  send back\n    call secret\n'
  const outPrivate = await open(server, 'file:///virtual/main.tree', usesPrivate)
  const priv = errors(published(outPrivate, 'file:///virtual/main.tree'))
  ok('scope: a `find` of a task private to another file is refused', priv.some(d => d.data?.name === 'private-name'), JSON.stringify(priv))

  const usesPublic = 'load @app/a\n  find open-one\n\ntask run\n  like text\n  send back\n    call open-one\n'
  const outPublic = await open(server, 'file:///virtual/public.tree', usesPublic)
  ok('scope: a public task of the same module is not refused', errors(published(outPublic, 'file:///virtual/public.tree')).length === 0, JSON.stringify(published(outPublic, 'file:///virtual/public.tree')))

  // two modules define `pick` at different types; this file imports the text one and passes a number
  const wrong =
    'load @app/pick-text\n  find pick\n\nload @app/pick-number\n  find other\n\ntask run\n  like text\n  send back\n    call pick\n      code 3\n'
  const outWrong = await open(server, 'file:///virtual/bind.tree', wrong)
  ok('scope: a call binds to the definition its file imported (a number does not fit it)', errors(published(outWrong, 'file:///virtual/bind.tree')).length > 0)

  const right = wrong.replace('code 3', 'text <x>')
  const outRight = await open(server, 'file:///virtual/bind.tree', right, 2)
  ok('scope: the same call with text fits the imported one', errors(published(outRight, 'file:///virtual/bind.tree')).length === 0, JSON.stringify(published(outRight, 'file:///virtual/bind.tree')))

  // ---- placement: an error inside an imported module is shown on the `load` that reached it ----
  const importsBroken = 'task first\n  like number\n  send back, code 1\n\nload @app/broken\n  find broken\n'
  const outBroken = await open(server, 'file:///virtual/importer.tree', importsBroken)
  const placed = errors(published(outBroken, 'file:///virtual/importer.tree'))
  ok(
    'placement: an imported module\'s error sits on the `load` line, naming the file',
    placed.length > 0 && placed.every(d => d.range.start.line === 4) && placed.some(d => d.message.includes('broken.tree')),
    JSON.stringify(placed),
  )
}

// ---- tests: a file of `test` blocks maps its diagnostics back to the lines the author wrote ----
{
  const server = new LanguageServer()
  const TEST =
    'task double\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      code 2\n\ntest <doubles>\n  want hold\n    call is-equal\n      call double\n        read nope\n      code 4\n'
  const out = await open(server, 'file:///virtual/double.tree', TEST)
  const found = errors(published(out, 'file:///virtual/double.tree'))
  const line = TEST.split('\n').findIndex(l => l.includes('read nope'))
  ok(
    'tests: an error inside a `want` lands on the line the author wrote',
    found.length > 0 && found[0]!.range.start.line === line,
    `${JSON.stringify(found.map(d => d.range))} want line ${line}`,
  )
  ok(
    'tests: and at the column the author wrote',
    found[0]?.range.start.character === TEST.split('\n')[line]!.indexOf('read nope'),
    JSON.stringify(found[0]?.range),
  )

  const clean = TEST.replace('read nope', 'code 2')
  const outClean = await open(server, 'file:///virtual/double.tree', clean, 2)
  ok('tests: a passing test file has no errors (not raw `test` heads read as names)', errors(published(outClean, 'file:///virtual/double.tree')).length === 0, JSON.stringify(published(outClean, 'file:///virtual/double.tree')))
}

// ---- keywords ----
{
  // metadata is `mark`: `note <metadata>` is the old spelling and is never offered
  const RETIRED =
    /\bwave\b|\bbust\b|send kink|\bauto\b|\bnote (private|async|native|unsafe|stable|unstable|deprecated|keep|draft|roam|open|feature|platform)\b/

  const labels = async (server: LanguageServer, uri: string, text: string) => {
    await open(server, uri, text)
    const answer = await request(server, 'textDocument/completion', { textDocument: { uri }, position: { line: text.split('\n').length - 1, character: 0 } })

    return (answer.result as { items: { label: string; insertText?: string }[] }).items
  }

  const longhand = await labels(new LanguageServer({ roleOf: () => 'code', leanOf: () => false }), 'file:///virtual/k.tree', 'task f\n  like number\n  send back, code 1\n\n')
  const lean = await labels(new LanguageServer({ roleOf: () => 'code', leanOf: () => true }), 'file:///virtual/k.tree', 'task f\n  like number\n\n  back 1\n\n')

  for (const [label, items] of [['longhand', longhand], ['lean', lean]] as const) {
    const retired = items.filter(i => RETIRED.test(`${i.label} ${i.insertText ?? ''}`))
    ok(`keywords: no retired word offered (${label})`, retired.length === 0, JSON.stringify(retired))

    for (const word of ['mark async', 'mark unsafe', 'tick', 'halt', 'seek', 'have', 'must', 'down', 'mark private', 'halt kink']) {
      ok(`keywords: \`${word}\` offered (${label})`, items.some(i => i.label === word || i.insertText === word), word)
    }
  }

  ok('keywords: `send back` in longhand, and no bare `back`', longhand.some(i => i.label === 'send back') && !longhand.some(i => i.label === 'back'))
  ok('keywords: bare `back` in a lean file', lean.some(i => i.label === 'back'))
  ok(
    'keywords: the longhand `walk` binds its item under `hook next` as `take site, name`',
    /hook next\n    take site, name/.test(longhand.find(i => i.label === 'walk')?.insertText ?? ''),
    longhand.find(i => i.label === 'walk')?.insertText,
  )
  ok('keywords: the lean `task` returns with `back`', /\n  back \$0/.test(lean.find(i => i.label === 'task')?.insertText ?? ''), lean.find(i => i.label === 'task')?.insertText)
  ok('keywords: the lean `fork` has `hold` / `miss` arms with no `hook`', /\n  hold\n/.test(lean.find(i => i.label === 'fork')?.insertText ?? '') && !/hook/.test(lean.find(i => i.label === 'fork')?.insertText ?? ''))
}

// ---- lint ----
{
  const server = new LanguageServer()
  const uri = 'file:///virtual/lint.tree'
  const TEXT = 'task five\n  like number\n  save x\n    code 5\n  send back, read x\n'
  const out = await open(server, uri, TEXT)
  const lint = (published(out, uri) ?? []).filter(d => d.source === 'term lint')
  ok('lint: a finding is a diagnostic, with its rule code', lint.some(d => d.code === 'L004'), JSON.stringify(published(out, uri)))

  const actions = (await request(server, 'textDocument/codeAction', {
    textDocument: { uri },
    range: lint[0]?.range ?? { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
    context: { diagnostics: lint },
  })).result as { title: string; kind: string; edit: { changes: Record<string, { range: Range; newText: string }[]> } }[]

  const fix = actions.find(a => a.kind === 'quickfix' && a.title.includes('L004'))
  ok('lint: its fix is a quick fix', !!fix, JSON.stringify(actions.map(a => a.title)))
  ok('lint: the fix writes `host`', !!fix && applyEdits(TEXT, fix.edit.changes[uri]!).includes('host x'), fix ? applyEdits(TEXT, fix.edit.changes[uri]!) : '')

  // the old spelling of privacy: warned, and rewritten by a quick fix
  const NOTE = 'task helper\n  note private\n  like number\n  send back, code 1\n\ntask main\n  like number\n  send back\n    call helper\n'
  const outNote = await open(server, 'file:///virtual/note.tree', NOTE)
  const warned = (published(outNote, 'file:///virtual/note.tree') ?? []).filter(d => d.data?.name === 'note-private')
  ok('lint: `note private` is warned', warned.length === 1, JSON.stringify(published(outNote, 'file:///virtual/note.tree')))

  const noteActions = (await request(server, 'textDocument/codeAction', {
    textDocument: { uri: 'file:///virtual/note.tree' },
    range: warned[0]?.range,
    context: { diagnostics: warned },
  })).result as { title: string; edit: { changes: Record<string, { range: Range; newText: string }[]> } }[]
  const rewrite = noteActions.find(a => a.title.includes('mark private'))
  const rewritten = rewrite ? applyEdits(NOTE, rewrite.edit.changes['file:///virtual/note.tree']!) : ''
  ok('lint: the quick fix writes `mark private`', rewritten.includes('  mark private\n') && !rewritten.includes('note private'), rewritten)

  // the old spelling of metadata: a `note-metadata` diagnostic, spanning `note async`, is rewritten to `mark async`.
  // The diagnostic is given here rather than read off the compiler, so this holds the quick fix alone.
  const META = 'task fetch\n  note async\n  like number\n  send back, code 1\n'
  const metaUri = 'file:///virtual/meta.tree'
  await open(server, metaUri, META)
  const metaDiagnostic = {
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 12 } },
    message: '`note async` is the old spelling of `mark async`',
    data: { name: 'note-metadata' },
  }
  const metaActions = (await request(server, 'textDocument/codeAction', {
    textDocument: { uri: metaUri },
    range: metaDiagnostic.range,
    context: { diagnostics: [metaDiagnostic] },
  })).result as { title: string; edit: { changes: Record<string, { range: Range; newText: string }[]> } }[]
  const metaFix = metaActions.find(a => a.title.includes('mark'))
  const metaFixed = metaFix ? applyEdits(META, metaFix.edit.changes[metaUri]!) : ''
  ok('lint: the `note-metadata` quick fix writes `mark async`', metaFixed === META.replace('note async', 'mark async'), metaFixed)
}

// ---- pull ----
{
  const server = new LanguageServer()
  await request(server, 'initialize', { capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } } })
  const init = await request(new LanguageServer(), 'initialize', { capabilities: { textDocument: { diagnostic: {} } } })
  ok('pull: advertised when the client can pull', !!(init.result as { capabilities: { diagnosticProvider?: unknown } }).capabilities.diagnosticProvider)

  const uri = 'file:///virtual/pull.tree'
  const out = await open(server, uri, 'task f\n  like number\n  send back\n    read nope\n')
  ok('pull: nothing is pushed to a client that pulls', published(out, uri) === undefined, JSON.stringify(out))

  const first = (await request(server, 'textDocument/diagnostic', { textDocument: { uri } })).result as { kind: string; resultId: string; items: Diag[] }
  ok('pull: a full report with the error', first.kind === 'full' && errors(first.items).length > 0, JSON.stringify(first))

  const again = (await request(server, 'textDocument/diagnostic', { textDocument: { uri }, previousResultId: first.resultId })).result as { kind: string }
  ok('pull: unchanged when nothing changed', again.kind === 'unchanged', JSON.stringify(again))

  await notify(server, 'textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'task f\n  like number\n  send back, code 1\n' }] })
  const after = (await request(server, 'textDocument/diagnostic', { textDocument: { uri }, previousResultId: first.resultId })).result as { kind: string; items: Diag[] }
  ok('pull: a full report again after an edit, now clean', after.kind === 'full' && errors(after.items).length === 0, JSON.stringify(after))
}

// ---- timing: debounce, settle, close ----
{
  const sent: Message[] = []
  const server = new LanguageServer({ debounce: 40, send: m => sent.push(m) })
  const uri = 'file:///virtual/timing.tree'
  await open(server, uri, 'task f\n  like number\n  send back, code 1\n')

  const before = sent.length

  for (let v = 2; v <= 6; v++) {
    const out = await notify(server, 'textDocument/didChange', {
      textDocument: { uri, version: v },
      contentChanges: [{ text: `task f\n  like number\n  send back\n    read nope${v}\n` }],
    })
    ok(`timing: edit ${v - 1} of 5 publishes nothing at once`, out.length === 0, JSON.stringify(out))
  }

  await new Promise(r => setTimeout(r, 150))
  const publishes = sent.slice(before).filter(m => m.method === 'textDocument/publishDiagnostics')
  ok('timing: a burst of five edits is analyzed once', publishes.length === 1, String(publishes.length))
  ok('timing: and that once is the last version', (publishes[0]?.params as { version?: number })?.version === 6 && JSON.stringify(publishes[0]).includes('nope6'), JSON.stringify(publishes[0]))

  // a request right after an edit is answered about the edited text, not the one analyzed before it
  await notify(server, 'textDocument/didChange', {
    textDocument: { uri, version: 7 },
    contentChanges: [{ text: 'task fresh-name\n  like number\n  send back, code 1\n' }],
  })
  const symbols = (await request(server, 'textDocument/documentSymbol', { textDocument: { uri } })).result as { name: string }[]
  ok('timing: a request settles the pending edit first', symbols.some(s => s.name === 'fresh-name'), JSON.stringify(symbols))

  // an edit then a close before the debounce fires: nothing is published for the closed document
  await notify(server, 'textDocument/didChange', { textDocument: { uri, version: 8 }, contentChanges: [{ text: 'task g\n  like number\n  send back\n    read gone\n' }] })
  const mark = sent.length
  await notify(server, 'textDocument/didClose', { textDocument: { uri } })
  await new Promise(r => setTimeout(r, 120))
  ok('timing: a closed document\'s pending analysis never publishes', !sent.slice(mark).some(m => JSON.stringify(m).includes('gone')), JSON.stringify(sent.slice(mark)))
  ok('timing: and its timer is gone', server.held().timers === 0 && server.held().documents === 0, JSON.stringify(server.held()))
}

// ---- sync: ranged edits and UTF-16 columns ----
{
  const server = new LanguageServer()
  const uri = 'file:///virtual/utf.tree'
  // one emoji is two UTF-16 units: a column counted in code points lands one left of everything after it
  const TEXT = 'task pair\n  take a, like text\n  take b, like text\n  like text\n  send back, read b\n\ntask use\n  take y, like text\n  like text\n  send back\n    call pair(text(<ἀ😀>), read y)\n'
  await open(server, uri, TEXT)

  const line = 10
  const column = TEXT.split('\n')[line]!.indexOf('read y') + 5
  const highlights = (await request(server, 'textDocument/documentHighlight', { textDocument: { uri }, position: { line, character: column } })).result as { range: Range }[]
  ok(
    'utf-16: a name after an emoji is found at its UTF-16 column',
    highlights.some(h => h.range.start.line === line && h.range.start.character === column && h.range.end.character === column + 1),
    JSON.stringify(highlights),
  )

  // a ranged change: rename `use` to `apply` by its range, on the line after the emoji's
  const at = TEXT.split('\n')[6]!.indexOf('use')
  await notify(server, 'textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ range: { start: { line: 6, character: at }, end: { line: 6, character: at + 3 } }, text: 'apply' }],
  })
  const symbols = (await request(server, 'textDocument/documentSymbol', { textDocument: { uri } })).result as { name: string }[]
  ok('sync: a ranged change is applied', symbols.some(s => s.name === 'apply') && !symbols.some(s => s.name === 'use'), JSON.stringify(symbols))

  // a ranged change after the emoji, on its own line, measured in UTF-16
  const emojiLine = TEXT.split('\n')[line]!
  const yAt = emojiLine.lastIndexOf('y')
  await notify(server, 'textDocument/didChange', {
    textDocument: { uri, version: 3 },
    contentChanges: [{ range: { start: { line, character: yAt }, end: { line, character: yAt + 1 } }, text: 'nope' }],
  })
  const diags = (await request(server, 'textDocument/diagnostic', { textDocument: { uri } })).result as { items: Diag[] }
  const unknown = errors(diags.items).find(d => d.message.includes('nope'))
  ok('utf-16: an edit after an emoji replaces exactly the character asked for', !!unknown && unknown.range.start.character <= yAt && unknown.range.end.character >= yAt + 4, JSON.stringify(diags.items))

  const init = await request(new LanguageServer(), 'initialize', { capabilities: { general: { positionEncodings: ['utf-8', 'utf-16'] } } })
  ok('utf-16: the position encoding is stated when the client offers a choice', (init.result as { capabilities: { positionEncoding?: string } }).capabilities.positionEncoding === 'utf-16')
}

// ---- robust: malformed documents and requests never throw ----
{
  const server = new LanguageServer()
  const texts = [
    '',
    '\n\n\n',
    'task',
    'task f\n  take',
    'task f\n\tlike number\n',
    'task f\r\n  like number\r\n  send back, code 1\r\n',
    'text <unclosed',
    '>>>> <<<< ,,,, ((((',
    'task f\n' + '  '.repeat(400) + 'call x\n',
    'load @nowhere/at/all\n  find nothing\n',
    'task f\n  like number\n  send back, code 1\n'.repeat(50),
    '\u0000\u0001\u0002 task',
    'x'.repeat(20000),
    'task 😀\n  like text\n',
    'fork test\n  hook test\n  hook hold\n',
  ]

  let answered = 0
  let asked = 0
  let threw = 0

  const methods = [
    'textDocument/hover',
    'textDocument/definition',
    'textDocument/references',
    'textDocument/rename',
    'textDocument/prepareRename',
    'textDocument/completion',
    'textDocument/signatureHelp',
    'textDocument/documentHighlight',
    'textDocument/selectionRange',
    'textDocument/prepareCallHierarchy',
    'textDocument/implementation',
  ]

  for (const [n, text] of texts.entries()) {
    const uri = `file:///virtual/bad-${n}.tree`

    try {
      await open(server, uri, text)
    } catch {
      threw++
    }

    for (const method of methods) {
      for (const position of [{ line: 0, character: 0 }, { line: 1, character: 3 }, { line: 999, character: 999 }]) {
        asked++

        try {
          const params = { textDocument: { uri }, position, positions: [position], newName: 'renamed', context: { includeDeclaration: true } }
          const answer = await request(server, method, params)

          if (answer && (answer.result !== undefined || answer.error !== undefined)) {
            answered++
          }
        } catch {
          threw++
        }
      }
    }

    for (const method of ['textDocument/documentSymbol', 'textDocument/foldingRange', 'textDocument/semanticTokens/full', 'textDocument/codeLens', 'textDocument/inlayHint', 'textDocument/codeAction', 'textDocument/diagnostic']) {
      asked++

      try {
        const answer = await request(server, method, { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 999, character: 0 } }, context: { diagnostics: [] } })

        if (answer && (answer.result !== undefined || answer.error !== undefined)) {
          answered++
        }
      } catch {
        threw++
      }
    }
  }

  ok(`robust: ${asked} requests over ${texts.length} malformed documents, none threw`, threw === 0, String(threw))
  ok(`robust: every one answered`, answered === asked, `${answered} of ${asked}`)

  // params that are not the method's shape: a request is answered (an error, or null for a document not open), a
  // notification is reported to the client's log, and nothing throws
  let handled = 0
  const shapes = [null, {}, { textDocument: {} }, { textDocument: { uri: 5 } }, { textDocument: { uri: 'file:///virtual/bad-0.tree' }, position: 'x' }]

  for (const params of shapes) {
    for (const method of ['textDocument/hover', 'textDocument/completion', 'textDocument/rename']) {
      try {
        const out = await server.dispatch({ jsonrpc: '2.0', id: 900, method, params })
        const answer = out.find(m => m.id === 900)

        if (answer && (answer.error !== undefined || answer.result !== undefined)) {
          handled++
        }
      } catch {
        threw++
      }
    }

    for (const method of ['textDocument/didOpen', 'textDocument/didChange']) {
      try {
        const out = await server.dispatch({ jsonrpc: '2.0', method, params })

        // a change to a document that is not open is nothing to do; an open with a uri and no text opens it empty;
        // anything else malformed is logged
        if (
          out.some(m => m.method === 'window/logMessage' || m.method === 'textDocument/publishDiagnostics') ||
          method === 'textDocument/didChange'
        ) {
          handled++
        }
      } catch {
        threw++
      }
    }
  }

  ok('robust: 25 messages with malformed params, all handled, none threw', threw === 0 && handled === 25, `${handled} handled, ${threw} threw`)
}

// ---- memory: a closed document is released ----
{
  const server = new LanguageServer()

  for (let i = 0; i < 40; i++) {
    await open(server, `file:///virtual/many-${i}.tree`, `task f${i}\n  like number\n  send back, code ${i}\n`)
  }

  ok('memory: forty documents held while open', server.held().documents === 40 && server.held().files === 40, JSON.stringify(server.held()))

  for (let i = 0; i < 40; i++) {
    await notify(server, 'textDocument/didClose', { textDocument: { uri: `file:///virtual/many-${i}.tree` } })
  }

  ok('memory: none held once closed', server.held().documents === 0 && server.held().files === 0, JSON.stringify(server.held()))
}

// ---- files outside a project, unsaved buffers, deleted files ----
{
  const disk: Record<string, string> = {
    '@app/lib': 'task greet\n  like text\n  send back, text <hi>\n',
  }
  const resolve = (path: string): Source | undefined =>
    disk[path] !== undefined ? { file: `/virtual/${path.slice(5)}.tree`, text: disk[path]! } : undefined

  const server = new LanguageServer({ resolve })
  const main = 'file:///virtual/uses-lib.tree'
  const out = await open(server, main, 'load @app/lib\n  find greet\n\ntask run\n  like text\n  send back\n    call greet\n')
  ok('buffers: a file importing a module compiles', errors(published(out, main)).length === 0, JSON.stringify(published(out, main)))

  // the module open in the editor with an unsaved edit that renames its task: the importer reads the BUFFER
  const edited = await open(server, 'file:///virtual/lib.tree', 'task welcome\n  like text\n  send back, text <hi>\n')
  ok('buffers: an unsaved edit to an imported module re-checks the open importer', errors(published(edited, main)).length > 0, JSON.stringify(edited))

  // closing the buffer goes back to the disk's text
  const closed = await notify(server, 'textDocument/didClose', { textDocument: { uri: 'file:///virtual/lib.tree' } })
  ok('buffers: closed, the module reads from disk again', closed.some(m => m.method === 'textDocument/publishDiagnostics'))
  await notify(server, 'workspace/didChangeWatchedFiles', { changes: [{ uri: 'file:///virtual/lib.tree', type: 2 }] })
  const settled = (await request(server, 'textDocument/diagnostic', { textDocument: { uri: main } })).result as { items: Diag[] }
  ok('buffers: and the importer is clean again', errors(settled.items).length === 0, JSON.stringify(settled))

  // the module deleted on disk: the watcher says so and the importer is analyzed again
  delete disk['@app/lib']
  const deleted = await notify(server, 'workspace/didChangeWatchedFiles', { changes: [{ uri: 'file:///virtual/lib.tree', type: 3 }] })
  ok('deleted: an importer of a deleted module is re-analyzed and fails', errors(published(deleted, main)).length > 0, JSON.stringify(deleted))

  // a file outside every project (no deck.tree above it) still compiles against the stdlib
  const outside = new LanguageServer()
  const lonely = await open(outside, 'file:///no-project-here/alone.tree', 'task f\n  like number\n  send back, code 1\n')
  ok('outside a project: compiles alone', errors(published(lonely, 'file:///no-project-here/alone.tree')).length === 0, JSON.stringify(lonely))

  const untitled = await open(outside, 'untitled:Untitled-1', 'task f\n  like number\n  send back\n    read nope\n')
  ok('an untitled buffer: analyzed, its error published', errors(published(untitled, 'untitled:Untitled-1')).length > 0)

  const stdlib = await open(
    outside,
    'untitled:Untitled-2',
    'load @term/base/code/text\n  find to-upper-case\n\ntask shout\n  take m, like text\n  like text\n  send back\n    call to-upper-case\n      read m\n',
  )
  ok('an untitled buffer: resolves the stdlib', errors(published(stdlib, 'untitled:Untitled-2')).length === 0, JSON.stringify(stdlib))
}

// ---- workspace: references, rename, symbols, call hierarchy across a package ----
{
  const root = join(term, 'test/server/fixture/workspace/code')
  const uri = (name: string): string => pathToFileURL(join(root, `${name}.tree`)).href
  const text = (name: string): string => readFileSync(join(root, `${name}.tree`), 'utf8')

  const server = new LanguageServer()
  await open(server, uri('b'), text('b'))

  // the call of `shout` in b.tree
  const callLine = text('b').split('\n').findIndex(l => l.includes('call shout'))
  const at = { line: callLine, character: text('b').split('\n')[callLine]!.indexOf('shout') + 1 }

  const refs = (await request(server, 'textDocument/references', { textDocument: { uri: uri('b') }, position: at, context: { includeDeclaration: true } })).result as { uri: string; range: Range }[]
  const files = new Set(refs.map(r => r.uri.split('/').pop()))
  ok('workspace: references reach the defining file', files.has('a.tree'), JSON.stringify(refs))
  ok('workspace: and the importer under another name, by its `find`', files.has('d.tree'))
  ok('workspace: but not a same-named task nobody imported', !files.has('c.tree'))
  ok('workspace: b.tree has its `find` and its call', refs.filter(r => r.uri === uri('b')).length === 2, JSON.stringify(refs.filter(r => r.uri === uri('b'))))

  const rename = (await request(server, 'textDocument/rename', { textDocument: { uri: uri('b') }, position: at, newName: 'holler' })).result as {
    changes: Record<string, { range: Range; newText: string }[]>
  }
  const after = (name: string): string => applyEdits(text(name), rename.changes[uri(name)] ?? [])
  ok('workspace: rename renames the definition', after('a').includes('task holler') && !after('a').includes('shout\n'), after('a'))
  ok('workspace: rename renames the import and the call', after('b').includes('find holler') && after('b').includes('call holler') && !after('b').includes('shout'), after('b'))
  ok('workspace: an aliased import has only its `find` renamed', after('d').includes('find holler, name yell') && after('d').includes('call yell'), after('d'))
  ok('workspace: the unrelated same-named task is untouched', rename.changes[uri('c')] === undefined)

  const prepare = (await request(server, 'textDocument/prepareRename', { textDocument: { uri: uri('b') }, position: { line: callLine, character: 4 } })).result
  ok('workspace: prepareRename refuses a position on `call`, not a name', prepare === null, JSON.stringify(prepare))

  const symbols = (await request(server, 'workspace/symbol', { query: 'shout' })).result as { name: string; location: { uri: string } }[]
  ok('workspace: symbol search finds both definitions of `shout`', symbols.filter(s => s.name === 'shout').length === 2, JSON.stringify(symbols))

  // call hierarchy: who calls `shout`, from its definition
  await open(server, uri('a'), text('a'))
  const defLine = text('a').split('\n').findIndex(l => l.startsWith('task shout'))
  const items = (await request(server, 'textDocument/prepareCallHierarchy', { textDocument: { uri: uri('a') }, position: { line: defLine, character: 6 } })).result as { name: string }[] | null
  ok('calls: prepare at a definition', items?.[0]?.name === 'shout', JSON.stringify(items))

  const incoming = (await request(server, 'callHierarchy/incomingCalls', { item: items?.[0] })).result as { from: { name: string; uri: string } }[]
  ok('calls: incoming from b.tree\'s `loud` and d.tree\'s `quiet`', incoming.some(c => c.from.name === 'loud') && incoming.some(c => c.from.name === 'quiet'), JSON.stringify(incoming))

  const loudLine = text('b').split('\n').findIndex(l => l.startsWith('task loud'))
  const loud = (await request(server, 'textDocument/prepareCallHierarchy', { textDocument: { uri: uri('b') }, position: { line: loudLine, character: 6 } })).result as unknown[]
  const outgoing = (await request(server, 'callHierarchy/outgoingCalls', { item: loud[0] })).result as { to: { name: string; uri: string } }[]
  ok('calls: outgoing from `loud` reach `shout` in a.tree', outgoing.some(c => c.to.name === 'shout' && c.to.uri === uri('a')), JSON.stringify(outgoing))
}

// ---- features ----
{
  const server = new LanguageServer()
  const uri = 'file:///virtual/features.tree'
  const TEXT =
    '# one\n# two\nload @term/base/code/text\n  find split\n\ntask outer\n  take n, like number\n  like number\n  save x\n    call add\n      read n\n      read n\n  send back, read x\n'
  await open(server, uri, TEXT)

  const folds = (await request(server, 'textDocument/foldingRange', { textDocument: { uri } })).result as { startLine: number; endLine: number; kind?: string }[]
  ok('folding: the comment run', folds.some(f => f.startLine === 0 && f.endLine === 1 && f.kind === 'comment'), JSON.stringify(folds))
  ok('folding: the load block as imports', folds.some(f => f.startLine === 2 && f.endLine === 3 && f.kind === 'imports'))
  ok('folding: the task', folds.some(f => f.startLine === 5 && f.endLine === 12))
  ok('folding: the nested call', folds.some(f => f.startLine === 9 && f.endLine === 11))

  const sel = (await request(server, 'textDocument/selectionRange', { textDocument: { uri }, positions: [{ line: 10, character: 11 }] })).result as { range: Range; parent?: unknown }[]
  const chain: Range[] = []
  let step = sel[0] as { range: Range; parent?: unknown } | undefined

  while (step) {
    chain.push(step.range)
    step = step.parent as typeof step
  }

  ok('selection: word, line, block, task, document', chain.length >= 5 && chain[0]!.end.character - chain[0]!.start.character === 1, JSON.stringify(chain))

  const marks = (await request(server, 'textDocument/documentHighlight', { textDocument: { uri }, position: { line: 10, character: 11 } })).result as { range: Range; kind: number }[]
  ok('highlight: the parameter where declared (write) and at both reads', marks.length === 3 && marks.filter(m => m.kind === 3).length === 1 && marks.every(m => m.range.end.character - m.range.start.character === 1), JSON.stringify(marks))

  const full = (await request(server, 'textDocument/semanticTokens/full', { textDocument: { uri } })).result as { resultId: string; data: number[] }
  ok('tokens: full carries a result id', typeof full.resultId === 'string' && full.data.length > 0)

  const same = (await request(server, 'textDocument/semanticTokens/full/delta', { textDocument: { uri }, previousResultId: full.resultId })).result as { edits?: unknown[]; resultId: string }
  ok('tokens: a delta with nothing changed has no edits', Array.isArray(same.edits) && same.edits.length === 0, JSON.stringify(same))

  await notify(server, 'textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: TEXT.replace('save x', 'save total').replace('read x', 'read total') }] })
  const changed = (await request(server, 'textDocument/semanticTokens/full/delta', { textDocument: { uri }, previousResultId: same.resultId })).result as { edits?: { start: number; deleteCount: number; data: number[] }[] }
  ok('tokens: a delta after an edit is one edit, not the whole array', Array.isArray(changed.edits) && changed.edits.length === 1, JSON.stringify(changed))

  const stale = (await request(server, 'textDocument/semanticTokens/full/delta', { textDocument: { uri }, previousResultId: 'not-a-result' })).result as { data?: number[] }
  ok('tokens: an unknown previous id answers in full', Array.isArray(stale.data))

  // every token is a name: decode and check each against the text
  const decoded: string[] = []
  let line = 0
  let character = 0

  for (let i = 0; i < full.data.length; i += 5) {
    line += full.data[i]!
    character = full.data[i] === 0 ? character + full.data[i + 1]! : full.data[i + 1]!
    decoded.push(TEXT.split('\n')[line]!.slice(character, character + full.data[i + 2]!))
  }

  ok('tokens: every token is a whole name', decoded.every(t => /^[a-z][A-Za-z0-9-]*$/.test(t)), JSON.stringify(decoded))

  // lean parameter-name hints
  const lean = new LanguageServer({ roleOf: () => 'code', leanOf: () => true })
  const leanUri = 'file:///virtual/hints.tree'
  const LEAN = 'task join-two\n  take left, like text\n  take right, like text\n\n  like text\n\n  back left\n\ntask use\n  like text\n\n  back join-two(<a>, <b>)\n'
  await open(lean, leanUri, LEAN)
  const hints = (await request(lean, 'textDocument/inlayHint', { textDocument: { uri: leanUri }, range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } } })).result as { label: string; position: { line: number; character: number } }[]
  const callLine = LEAN.split('\n')[11]!
  ok(
    'hints: a lean call shows each argument\'s parameter',
    hints.some(h => h.label === 'left:' && h.position.line === 11 && h.position.character === callLine.indexOf('<a>')) &&
      hints.some(h => h.label === 'right:' && h.position.line === 11 && h.position.character === callLine.indexOf('<b>')),
    JSON.stringify(hints),
  )

  const longHints = (await request(server, 'textDocument/inlayHint', { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } } })).result as { label: string }[]
  ok('hints: a longhand file gets no parameter-name hints', !longHints.some(h => h.label.endsWith(':') && !h.label.startsWith(':')), JSON.stringify(longHints))
}

console.log(`\nserver/current: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
