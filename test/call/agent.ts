// The agent-facing verbs, through the real CLI in a temp project: the fixes `term scan` carries and `--fix` writes,
// typed holes, `term show kink`, `term show name`, `term roll --diff` and `term self skill`. Each answer is read as the
// JSON an agent reads. Run: npx tsx test/call/agent.ts

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFixes } from '@term/make/code/fix'
import { diagnosticNames } from '@term/make/code/parser/diagnostic'
import { lintCatalog } from '@term/make/code/lint/lint'

const TERM_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LINE = join(TERM_ROOT, 'deck', 'call', 'code', 'line.ts')
const TSCONFIG = join(TERM_ROOT, 'tsconfig.json')

let pass = 0
let fail = 0

function expect(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

// the CLI, from source, in `cwd`: its stdout and exit status
function term(args: string[], cwd: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('npx', ['tsx', LINE, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
    })

    return { stdout, status: 0 }
  } catch (e: unknown) {
    const err = e as { stdout?: string; status?: number }

    return { stdout: err.stdout ?? '', status: err.status ?? 1 }
  }
}

function json(args: string[], cwd: string): { data: any; status: number } {
  const run = term(args, cwd)

  try {
    return { data: JSON.parse(run.stdout.trim()), status: run.status }
  } catch {
    return { data: { unparsed: run.stdout }, status: run.status }
  }
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, file), text)
}

type Edit = { span: { start: { line: number; column: number }; end: { line: number; column: number } }; text: string; was: string }

// one edit applied to a text by its span, as an agent applies a fix it picked
function applyEdit(text: string, edit: Edit): string {
  const lines = text.split('\n')
  const line = lines[edit.span.start.line]!

  lines[edit.span.start.line] = line.slice(0, edit.span.start.column) + edit.text + line.slice(edit.span.end.column)

  return lines.join('\n')
}

function scanFixes(dir: string): void {
  // a near spelling: a guess, on the name alone
  write(dir, 'typo.tree', 'task greet\n  take who, like text\n  like text\n\n  send back, read whom\n')
  const typo = json(['scan', 'typo.tree', '--back', 'json'], dir)
  const near = typo.data.diagnostics?.[0]
  const nearFix = near?.fixes?.[0]

  expect('scan: an unknown name carries its near spelling as a fix', near?.name === 'unknown-name' && nearFix?.title === 'Write "who"', near)
  expect('scan: the near spelling is a guess, not sure', nearFix?.sure === false, nearFix)
  expect('scan: the edit spans the name alone and expects it', nearFix?.edits?.[0]?.was === 'whom' && nearFix?.edits?.[0]?.span.start.column === 18, nearFix)
  expect(
    'scan: the edit applied reads `read who`',
    nearFix && applyEdit(readFileSync(join(dir, 'typo.tree'), 'utf8'), nearFix.edits[0]).includes('send back, read who\n'),
  )

  // an old spelling: sure, and written by --fix
  write(dir, 'old.tree', 'task greet\n  take who, like text\n  like text\n  note private\n\n  send back, read who\n\ntask shout\n  take who, like text\n  like text\n  note deprecated\n\n  send back, read who\n')
  const old = json(['scan', 'old.tree', '--back', 'json'], dir)
  const sure = (old.data.diagnostics ?? []).flatMap((d: { fixes: { sure: boolean }[] }) => d.fixes).filter((f: { sure: boolean }) => f.sure)

  expect('scan: `note private` and `note deprecated` each carry a sure fix', sure.length === 2, old.data)

  const fixed = json(['scan', 'old.tree', '--fix', '--back', 'json'], dir)
  const after = readFileSync(join(dir, 'old.tree'), 'utf8')

  expect('scan --fix: both sure fixes applied, and the file scanned again', fixed.data.applied?.length === 2 && fixed.data.ok === true, fixed.data)
  expect('scan --fix: the file now says `mark`', after.includes('  mark private\n') && after.includes('  mark deprecated\n') && !after.includes('note '), after)
  expect('scan --fix: no sure fix is left', (fixed.data.diagnostics ?? []).every((d: { fixes: { sure: boolean }[] }) => d.fixes.every(f => !f.sure)), fixed.data)

  // a guess is never written
  write(dir, 'guess.tree', 'task greet\n  take who, like text\n  like text\n\n  send back, read whom\n')
  term(['scan', 'guess.tree', '--fix', '--back', 'json'], dir)
  expect('scan --fix: a guess is offered, never written', readFileSync(join(dir, 'guess.tree'), 'utf8').includes('read whom'))

  // an import: one fix per module that exports the name
  write(dir, 'import.tree', 'task line-of\n  take words, like list, like text\n  like text\n\n  send back\n    call join\n      read words\n      text < >\n')
  const imported = json(['scan', 'import.tree', '--back', 'json'], dir)
  const imports = (imported.data.diagnostics?.[0]?.fixes ?? []).map((f: { title: string }) => f.title)

  expect('scan: an unknown name a module exports is offered as an import', imports.some((t: string) => t.startsWith('Import join from @term/base/')), imported.data)
  expect('scan: an import from a platform module is not offered', !imports.some((t: string) => t.includes('/native/')), imports)

  // applying refuses an edit whose text moved, and an edit over another
  const span = { start: { line: 0, column: 0 }, end: { line: 0, column: 4 } }
  const stale = applyFixes('task x\n', [{ title: 'a', sure: true, edits: [{ span, text: 'form', was: 'form' }] }])
  const clash = applyFixes('task x\n', [
    { title: 'a', sure: true, edits: [{ span, text: 'form', was: 'task' }] },
    { title: 'b', sure: true, edits: [{ span, text: 'mask', was: 'task' }] },
  ])

  expect('applyFixes: an edit whose span no longer holds `was` is refused', stale.applied.length === 0 && stale.refused.length === 1 && stale.text === 'task x\n', stale)
  expect('applyFixes: an edit over one already taken is refused whole', clash.applied.length === 1 && clash.refused.length === 1 && clash.text === 'form x\n', clash)
}

function typedHoles(dir: string): void {
  write(dir, 'hole.tree', 'task total\n  take count, like number\n  take label, like text\n  like number\n\n  save base, code 10\n  send back\n    call add\n      read count\n      read hole\n')
  const hole = json(['scan', 'hole.tree', '--back', 'json'], dir)
  const found = hole.data.diagnostics?.[0]
  const titles = (found?.fixes ?? []).map((f: { title: string }) => f.title)

  expect('hole: reported as typed-hole, an error', hole.status === 1 && found?.name === 'typed-hole' && found?.severity === 'error', hole.data)
  expect('hole: the message names the type the place needs', found?.message === 'this hole needs a value of type number', found)
  expect('hole: every value in scope of that type is a fix, and nothing else', titles.length === 2 && titles.includes('Write "base" (number)') && titles.includes('Write "count" (number)'), titles)
  expect('hole: the hint names the values and the tasks that return the type', /base, count/.test(found?.hint ?? '') && /Tasks that return it: total/.test(found?.hint ?? ''), found?.hint)
  expect('hole: each fix replaces the word `hole`', (found?.fixes ?? []).every((f: { edits: Edit[] }) => f.edits[0]?.was === 'hole'), found?.fixes)

  write(dir, 'hole.tree', applyEdit(readFileSync(join(dir, 'hole.tree'), 'utf8'), found.fixes[0].edits[0]))
  expect('hole: a fix applied leaves a file that checks', json(['scan', 'hole.tree', '--back', 'json'], dir).data.ok === true)

  write(dir, 'free.tree', 'task idle\n  save x, hole\n')
  const free = json(['scan', 'free.tree', '--back', 'json'], dir)

  expect('hole: one nothing decides says it can be any type', free.data.diagnostics?.[0]?.message === 'this hole can be a value of any type', free.data)

  // a program that names something `hole` reads as it did
  write(dir, 'named.tree', 'task keep\n  take hole, like number\n  like number\n\n  send back, read hole\n')
  expect('hole: a parameter named `hole` is a parameter, not a hole', json(['scan', 'named.tree', '--back', 'json'], dir).data.ok === true)
}

function showKink(dir: string): void {
  const byName = json(['show', 'kink', 'type-mismatch', '--back', 'json'], dir).data
  const printed = json(['show', 'kink', '0007', '--back', 'json'], dir).data
  const number = json(['show', 'kink', '7', '--back', 'json'], dir).data
  const hex = json(['show', 'kink', '0x7', '--back', 'json'], dir).data
  const lint = json(['show', 'kink', 'L019', '--back', 'json'], dir).data
  const hole = json(['show', 'kink', 'typed-hole', '--back', 'json'], dir).data
  const sure = json(['show', 'kink', 'note-private', '--back', 'json'], dir).data
  const missing = json(['show', 'kink', 'unknown-nam', '--back', 'json'], dir)
  const all = json(['show', 'kink', '--back', 'json'], dir).data as { kind: string; name: string; code: unknown }[]

  expect('kink: by name', byName.name === 'type-mismatch' && byName.code === 7 && byName.label === '0007', byName)
  expect('kink: by the code as printed, as JSON gives it, and in hexadecimal', printed.name === 'type-mismatch' && number.name === 'type-mismatch' && hex.name === 'type-mismatch')
  expect('kink: a lint code', lint.kind === 'lint' && lint.name === 'max-line-length', lint)
  expect('kink: says whether its fixes are sure or guesses', hole.fixes === 'guess' && sure.fixes === 'sure', { hole, sure })
  expect('kink: a miss fails and names the nearest', missing.status === 1 && missing.data.nearest === 'unknown-name', missing.data)
  expect('kink: the catalog holds every compiler diagnostic', diagnosticNames().every(name => all.some(k => k.kind === 'compiler' && k.name === name)))
  expect('kink: the catalog holds every lint finding the driver reports', lintCatalog().every(rule => all.some(k => k.kind === 'lint' && k.code === rule.code)))
}

function showName(dir: string): void {
  const project = join(dir, 'names')

  write(project, 'deck.tree', 'deck @probe/names\nhead <A probe for term show name>\nmark <0.0.0>\n')
  write(
    project,
    'code/post.tree',
    'load @term/base/text\n  find to-upper-case\n\n# one blog post\nform post\n  link title, like text\n  link body, like text\n\n# a title as written\ntask tidy\n  take title, like text\n  like text\n\n  send back, read title\n\n# the post with its title shouted\ntask shout-post\n  take given, like post\n  like post\n\n  send back\n    make post\n      bind title, call to-upper-case(call tidy(read given/title))\n      bind body, call nowhere-task(read given/body)\n',
  )
  write(
    project,
    'code/page.tree',
    'load ./post\n  find post\n  find shout-post\n\ntask front-page\n  take title, like text\n  like post\n\n  save draft\n    make post\n      bind title, read title\n      bind body, text <>\n  send back, call shout-post(read draft)\n',
  )

  const slice = json(['show', 'name', 'shout-post', '--back', 'json'], project).data
  const definition = slice.definitions?.[0]

  expect('name: the definition, whole, with its doc comment', definition?.place === 'code/post.tree' && definition?.line === 17 && definition?.doc === 'the post with its title shouted' && definition?.shown === 'whole', slice)
  expect('name: the form its signature names', slice.forms?.length === 1 && slice.forms[0].name === 'post', slice.forms)
  expect('name: every use in the project', slice.uses?.length === 1 && slice.uses[0].in === 'front-page' && slice.uses[0].place === 'code/page.tree', slice.uses)
  expect(
    'name: the heads of what it calls, through a load and in its own file',
    slice.calls?.some((c: { name: string; place: string }) => c.name === 'to-upper-case' && c.place.startsWith('@term/base/')) && slice.calls?.some((c: { name: string }) => c.name === 'tidy'),
    slice.calls,
  )
  expect('name: a call nothing defines is named, not dropped', slice.unresolved?.length === 1 && slice.unresolved[0] === 'nowhere-task', slice.unresolved)

  const form = json(['show', 'name', 'post', '--back', 'json'], project).data

  expect('name: a form is used where it is made and where a signature names it', form.uses?.length === 4, form.uses)

  const small = json(['show', 'name', 'shout-post', '--budget', '40', '--back', 'json'], project).data

  expect('name: a small budget shows the head and counts what it left out', small.definitions?.[0]?.shown === 'head' && small.omitted?.bodies === 1 && small.used <= 40, small)

  const tiny = json(['show', 'name', 'shout-post', '--budget', '1', '--back', 'json'], project).data

  expect('name: a budget too small for the head still names the definition', tiny.definitions?.[0]?.shown === 'place' && tiny.definitions?.[0]?.place === 'code/post.tree', tiny)
  expect('name: a name that exists nowhere fails', json(['show', 'name', 'no-such-name', '--back', 'json'], project).status === 1)
}

function rollDiff(dir: string): void {
  const project = join(dir, 'rolls')

  write(project, 'deck.tree', 'deck @probe/rolls\nhead <A probe for term roll --diff>\nmark <0.0.0>\n')
  write(project, 'code/note.tree', '# a note\ntask save-note\n  take text, like text\n  like text\n\n  send back, read text\n')
  writeFileSync(join(project, 'before.json'), term(['roll', '--json'], project).stdout)

  const quiet = json(['roll', '--diff', 'before.json', '--back', 'json', '--strict'], project)

  expect('roll --diff: nothing changed, nothing listed, exit 0', quiet.status === 0 && quiet.data.tasks?.changed?.length === 0 && quiet.data.decks?.length === 0, quiet.data)

  write(
    project,
    'code/note.tree',
    'load @term/base/file\n  find write\n\n# a note, written to disk\ntask save-note\n  take text, like text\n  like text\n\n  call write\n    text <note.txt>\n    read text\n  send back, read text\n\n# a count\ntask count-words\n  take text, like text\n  like number\n\n  send back, text/length\n',
  )

  const diff = json(['roll', '--diff', 'before.json', '--back', 'json'], project)
  const changed = diff.data.tasks?.changed?.[0]

  expect('roll --diff: a task that now writes a file gained node:fs/promises', changed?.name === 'save-note' && changed?.reach?.added?.includes('node:fs/promises'), diff.data)
  expect('roll --diff: and what it now raises, and that it became async', changed?.halt?.added?.includes('failure') && changed?.async?.after === true, changed)
  expect('roll --diff: a new task is listed with its reach', diff.data.tasks?.added?.some((t: { name: string; reach: string[] }) => t.name === 'count-words' && t.reach.length === 0), diff.data.tasks)
  expect('roll --diff: a deck the project now loads is counted, not listed', diff.data.decks?.length === 1 && diff.data.decks[0].host === '@term/base' && diff.data.decks[0].tasks.added > 0, diff.data.decks)
  expect('roll --diff: a gained native module fails --strict', term(['roll', '--diff', 'before.json', '--strict'], project).status === 1)
  expect('roll --diff: a ref this repository does not have is refused', json(['roll', '--diff', 'no-such-ref-anywhere', '--back', 'json'], project).status === 1)
}

function selfSkill(dir: string): void {
  const project = join(dir, 'skill')

  write(project, 'deck.tree', 'deck @probe/skill\nmark <0.0.0>\n')
  mkdirSync(join(project, 'code'), { recursive: true })

  const first = json(['self', 'skill', '--back', 'json'], join(project, 'code')).data
  const file = join(project, '.claude', 'skills', 'term', 'SKILL.md')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''

  expect('skill: written at the project root, from a folder inside it', first.state === 'written' && existsSync(file), first)
  expect('skill: names the verbs it teaches', ['term scan', '--fix', 'typed-hole', 'term show kink', 'term show name', 'term roll --diff'].every(word => text.includes(word)))
  expect('skill: a second run finds it current', json(['self', 'skill', '--back', 'json'], project).data.state === 'current')

  const other = join(dir, 'skill-other')

  write(other, 'deck.tree', 'deck @probe/other\nmark <0.0.0>\n')
  write(other, '.claude/skills/term/SKILL.md', 'my own skill\n')

  const kept = json(['self', 'skill', '--back', 'json'], other)

  expect('skill: a file it did not write is kept, and the run fails', kept.status === 1 && kept.data.state === 'kept' && readFileSync(join(other, '.claude/skills/term/SKILL.md'), 'utf8') === 'my own skill\n', kept.data)
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'term-agent-'))

  scanFixes(dir)
  typedHoles(dir)
  showKink(dir)
  showName(dir)
  rollDiff(dir)
  selfSkill(dir)

  console.log(`\nagent: ${pass} pass, ${fail} fail`)

  if (fail) {
    process.exit(1)
  }
}

main()
