// `length` everywhere (`pnpm term:length-migrate`), note/project/term/decisions-2026-10/decisions-2026-10.md, D2.
//
// A collection's length is `length`: `list`, `hash`, `set`, `queue`, `stack`, `deque`, `heap`, `bitset`, `bytes` and
// `sorted-map` each answer it, and their older `size` and one-argument `count` stay one release, deprecated. A vector's
// and a quaternion's `length` was their NORM, which is `magnitude` now. This moves every call in the repository to the
// new names: every package's `.tree` files, and with `--guides` the compiled `tree` fences of note/project/term/guides/draft.
//
// A call is found by what the CHECKER resolved it to, never by its spelling: a `size(x)` that reaches a file's
// metadata, or a `count(xs, test)` that counts matching items, resolves to another task and is left alone. The word is
// rewritten at the call's own span (`size` in `call size`, in `size(x)` and in `xs/size()`), in the text as written,
// a test file's rewritten lines placed back on its own (call/code/test-preprocess.ts `readable`).
//
// Each changed text is PROVEN before it is written: its own statements, as the checker left them and spans aside, are
// equal before and after once each old task's name is read as the new one's. So the change moved calls from one task
// to the other and nothing else, and the two have one body. A text that does not build before is left as it is.
//
//   pnpm term:length-migrate                     report what would change in every package
//   pnpm term:length-migrate --commit            write each file whose proof holds
//   pnpm term:length-migrate --only=base,zone    those packages
//   pnpm term:length-migrate --guides            the guides' `tree` fences instead
//   --explain                                    where an unproven text's two programs part
//
// Run from the Term root, where the `@term/*` paths resolve (the alias starts there).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { buildable, findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { carriesTests, readable } from '@term/call/code/test-preprocess'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { parse, renderHead } from '@term/make/code/parser/tree'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { TERM_ROOT, parentPaths, parentRoot } from './root'

const TERM = TERM_ROOT
const REPO = TERM_ROOT
const commit = process.argv.includes('--commit')
const explain = process.argv.includes('--explain')
// `--names`: print each distinct task name a call resolved to that looks like one of the moved words (how a new move is
// written against what the checker calls a task, never its spelling)
const names = process.argv.includes('--names')
const PROBE_WORDS = ['plus', 'minus', 'times', 'divided-by', 'to-upper', 'to-lower', 'trim', 'contains', 'starts-with', 'ends-with', 'replace']
const NAME_PROBE = new RegExp(`(^|_)(${PROBE_WORDS.join('|')})(__.*)?$`)
const seenNames = new Set<string>()

// the seven aliases of text/string.tree and the `text` task each stands for
const TEXT_ALIASES: Record<string, string> = {
  'to-upper': 'to-upper-case',
  'to-lower': 'to-lower-case',
  trim: 'trim',
  contains: 'contains',
  'starts-with': 'starts-with',
  'ends-with': 'ends-with',
  replace: 'replace-all',
}
const aliasCalls: string[] = []

const ARITHMETIC_NOW: Record<string, string> = { plus: 'add', minus: 'subtract', times: 'multiply', 'divided-by': 'divide' }
// each form and the old arithmetic names it still defines
const ARITHMETIC: [string, string[]][] = [
  ['vector-2', ['plus', 'minus']],
  ['vector-3', ['plus', 'minus']],
  ['vector-4', ['plus', 'minus']],
  ['duration', ['plus', 'minus']],
  ['complex', ['plus', 'minus', 'times']],
  ['rational', ['plus', 'minus', 'times', 'divided-by']],
  ['quaternion', ['times']],
  ['matrix-4', ['times']],
]

// each old task, by the name the checker gives a form's task (`<form>_<task>`), to the word it is written as and the
// word it becomes
const MOVES: { task: string; old: string; now: string }[] = [
  ...['list', 'hash', 'set', 'queue', 'stack'].map(form => ({ task: `${form}_size`, old: 'size', now: 'length' })),
  ...['list', 'hash', 'set', 'deque', 'heap', 'bitset', 'sorted-map'].map(form => ({ task: `${form}_count`, old: 'count', now: 'length' })),
  ...['vector-2', 'vector-3', 'vector-4', 'quaternion'].map(form => ({ task: `${form}_length`, old: 'length', now: 'magnitude' })),
  // the arithmetic names: `plus`, `minus`, `times` and `divided-by` are `add`, `subtract`, `multiply` and `divide`
  ...ARITHMETIC.flatMap(([form, olds]) => olds.map(old => ({ task: `${form}_${old}`, old, now: ARITHMETIC_NOW[old]! }))),
]

// a text that holds none of the old words has nothing to move
const WORDS = new RegExp(`(?<![\\w-])(${[...new Set([...MOVES.map(move => move.old), ...PROBE_WORDS])].join('|')})(?![\\w-])`)

const byTask = new Map(MOVES.map(move => [move.task, move]))
const renamedTask = new Map(MOVES.map(move => [move.task, `${move.task.slice(0, move.task.lastIndexOf('_'))}_${move.now}`]))

type Edit = { line: number; start: number; end: number; now: string }
type Built = ReturnType<typeof compile>
type Build = (text: string) => { result: Built; place?: (d: Diagnostic) => { diagnostic: Diagnostic } }

// every call node in a statement, its callee a variable, found by walking the node's own fields
function callsIn(node: unknown, out: { name: string; span: Span }[]): void {
  const stack: unknown[] = [node]

  while (stack.length > 0) {
    const one = stack.pop()

    if (!one || typeof one !== 'object') {
      continue
    }

    if (Array.isArray(one)) {
      stack.push(...one)
      continue
    }

    const record = one as { form?: string; callee?: { form?: string; name?: string; span?: Span } }

    if (record.form === 'call' && record.callee?.form === 'variable' && record.callee.name && record.callee.span) {
      out.push({ name: record.callee.name, span: record.callee.span })
    }

    for (const [key, value] of Object.entries(one)) {
      if (key !== 'span' && key !== 'type') {
        stack.push(value)
      }
    }
  }
}

// THE PROOF. A text's own statements as the checker left them, spans aside, and with `renamed` every old task's name
// read as the new one's. Compared as checked programs, not emitted text, so which unused copy of a task the
// tree-shaker happens to keep cannot decide it
function ownStatements(program: unknown[], file: string, renamed: boolean): string {
  const own = program.filter(statement => ((statement as { span?: Span }).span?.file ?? file) === file)

  return JSON.stringify(own, (key, value: unknown) => {
    if (key === 'span' || key === 'origin' || key === 'markers') {
      return undefined
    }

    return renamed && typeof value === 'string' && renamedTask.has(value) ? renamedTask.get(value) : value
  })
}

// one text moved to the new names: undefined when it does not build or calls nothing to move, else the new text, how
// many calls moved, and whether the proof holds (with why not)
function migrate(
  file: string,
  text: string,
  build: Build,
): { text: string; calls: number; proven: boolean; why?: string } | 'broken' | undefined {
  // quaternion's and matrix-4's `multiply` call `times`, which holds the implementation: moving that call would make
  // `multiply` call itself, so the body moves into `multiply` by hand first (cleanup-0006)
  if (/base\/code\/line\/float\/32\/(quaternion|matrix-4)\.tree$/.test(file)) {
    return undefined
  }

  const before = build(text)

  if (!before.result.ok) {
    return 'broken'
  }

  const found: { name: string; span: Span }[] = []

  for (const statement of before.result.program) {
    if ((statement.span.file ?? file) === file) {
      callsIn(statement, found)
    }
  }

  // the seven text aliases are top-level tasks of text/string.tree, told apart from `text`'s own tasks of the same
  // names by the file the checker defined them in (a task defined in two files is split by file, `contains__in0_0`)
  const aliasNames = new Set<string>()

  for (const statement of before.result.program as { name?: string; span?: Span }[]) {
    const stem = statement.name?.replace(/__in\d+_\d+$/, '')

    if (stem && stem in TEXT_ALIASES && statement.span?.file?.endsWith('base/code/text/string.tree')) {
      aliasNames.add(statement.name!)
    }
  }

  const lines = text.split('\n')
  const edits: Edit[] = []

  for (const call of found) {
    if (aliasNames.has(call.name)) {
      aliasCalls.push(`${file}:${call.span.start.line + 1} ${call.name}`)
    }

    if (names && NAME_PROBE.test(call.name) && !seenNames.has(call.name)) {
      seenNames.add(call.name)
      console.log(`name ${call.name} in ${file}`)
    }

    const move = byTask.get(call.name)

    if (!move) {
      continue
    }

    const span = before.place ? before.place({ span: call.span, markers: [] } as unknown as Diagnostic).diagnostic.span : call.span
    const line = lines[span.start.line] ?? ''
    const end = span.end.line === span.start.line ? span.end.column : line.length
    // the old word, the last whole one in the callee's span: `size` in `size`, in `xs/size`
    const at = [...line.slice(span.start.column, end).matchAll(new RegExp(`(?<![\\w-])${move.old}(?![\\w-])`, 'g'))].pop()?.index

    if (at === undefined) {
      continue
    }

    const start = span.start.column + at

    if (!edits.some(e => e.line === span.start.line && e.start === start)) {
      edits.push({ line: span.start.line, start, end: start + move.old.length, now: move.now })
    }
  }

  if (edits.length === 0) {
    return undefined
  }

  for (const edit of [...edits].sort((a, b) => b.line - a.line || b.start - a.start)) {
    const line = lines[edit.line]!
    lines[edit.line] = `${line.slice(0, edit.start)}${edit.now}${line.slice(edit.end)}`
  }

  const next = lines.join('\n')
  const after = build(next)

  if (!after.result.ok) {
    return { text: next, calls: edits.length, proven: false, why: `does not build after: ${after.result.diagnostics[0]?.message ?? ''}` }
  }

  const was = ownStatements(before.result.program, file, true)
  const now = ownStatements(after.result.program, file, false)

  if (was !== now) {
    const at = [...was].findIndex((char, i) => char !== now[i])

    return {
      text: next,
      calls: edits.length,
      proven: false,
      why: explain ? `the program differs:\n    was ${was.slice(Math.max(0, at - 120), at + 120)}\n    now ${now.slice(Math.max(0, at - 120), at + 120)}` : 'the program differs',
    }
  }

  return { text: next, calls: edits.length, proven: true }
}

let texts = 0
let changed = 0
let calls = 0
const unproven: string[] = []
const broken: string[] = []

const record = (where: string, done: ReturnType<typeof migrate>, write: (text: string) => void): void => {
  texts++

  if (done === 'broken') {
    broken.push(where)
    return
  }

  if (!done) {
    return
  }

  changed++
  calls += done.calls

  if (!done.proven) {
    unproven.push(`${where} (${done.why})`)
    return
  }

  console.log(`${commit ? 'wrote ' : 'would '}${where}: ${done.calls} call${done.calls === 1 ? '' : 's'}`)

  if (commit) {
    write(done.text)
  }
}

// THE IMPORTS. A file that called `size(xs)` imported it, `load @term/base/list` with `find size`, and calls `length`
// now. In a file whose program calls no old task any more, a `find size` or `find count` under a load of a collection's
// module becomes `find length`, or goes when `find length` is already beside it. An import changes nothing a backend
// writes, so the proof is the same TypeScript, byte for byte
const COLLECTION_MODULES = /^@term\/base\/(code\/)?(list|hash|set|bytes|bitset|sorted-map|list\/(queue|stack|deque|heap))$/

// read by the compiler's parser: each top-level `load` group, its path, and its `find` groups with the line each is on
function tidyFinds(text: string): string {
  const parsed = parse({ file: 'scan.tree', text })

  if (!parsed.ok) {
    return text
  }

  const lines = text.split('\n')
  // the lines to drop, and the lines to write `find length` on
  const drop = new Set<number>()
  const rename = new Set<number>()
  const head = (group: GroupNode): string | undefined => (group.nodes[0]?.kind === 'name' ? renderHead(group.nodes[0]) : undefined)

  for (const load of parsed.tree.nodes) {
    if (load.kind !== 'group' || head(load) !== 'load') {
      continue
    }

    const pathGroup = load.nodes[1]
    const module = pathGroup?.kind === 'group' ? head(pathGroup) : undefined

    if (!module || !COLLECTION_MODULES.test(module)) {
      continue
    }

    const finds = load.nodes.slice(2).flatMap(node => {
      if (node.kind !== 'group' || head(node) !== 'find') {
        return []
      }

      const target = node.nodes[1]
      const name = target?.kind === 'group' ? head(target) : undefined
      const line = spanOfNode(node)?.start.line

      // an aliased find (`find size, name n`) is left alone
      return name !== undefined && line !== undefined && node.nodes.length === 2 ? [{ name, line }] : []
    })
    let hasLength = finds.some(find => find.name === 'length')

    for (const find of finds.filter(one => one.name === 'size' || one.name === 'count')) {
      if (hasLength) {
        drop.add(find.line)
      } else {
        rename.add(find.line)
        hasLength = true
      }
    }
  }

  return lines
    .flatMap((line, at) => (drop.has(at) ? [] : rename.has(at) ? [line.replace(/\bfind (size|count)\b/, 'find length')] : [line]))
    .join('\n')
}

if (process.argv.includes('--finds')) {
  const roots = [
    ...readdirSync(path.join(TERM, 'deck'))
      .map(name => path.join(TERM, 'deck', name))
      .filter(dir => existsSync(path.join(dir, 'deck.tree'))),
    ...parentPaths('deck/zone'),
  ]

  for (const root of roots) {
    const resolve = projectResolver(root)
    const deckOf = projectDeckOf()
    const roleOf = projectRoleOf(root)
    const leanOf = projectLeanOf(root)

    for (const file of findTreeFiles(root, [], 'node')) {
      const source = readFileSync(file, 'utf8')

      if (!/^\s+find (size|count)\s*$/m.test(source)) {
        continue
      }

      const build = (text: string) => {
        const built = buildable(file, text, roleOf(file))
        const unit = 'faults' in built ? text : built.text

        return compile({ file, text: carriesTests(unit) ? readable(unit).text : unit }, { resolve, deckOf, roleOf, leanOf, env: 'node' })
      }
      const before = build(source)
      const where = path.relative(REPO, file)

      texts++

      if (!before.ok) {
        broken.push(where)
        continue
      }

      // a file that still calls an old task keeps its import
      const found: { name: string; span: Span }[] = []
      before.program.filter(s => (s.span.file ?? file) === file).forEach(s => callsIn(s, found))

      if (found.some(call => byTask.has(call.name))) {
        continue
      }

      const next = tidyFinds(source)

      if (next === source) {
        continue
      }

      const after = build(next)
      changed++

      if (!after.ok || after.typescript !== before.typescript) {
        unproven.push(`${where} (${after.ok ? 'the TypeScript differs' : `does not build after: ${after.diagnostics[0]?.message ?? ''}`})`)
        continue
      }

      console.log(`${commit ? 'wrote ' : 'would '}${where}`)

      if (commit) {
        writeFileSync(file, next)
      }
    }
  }
} else if (process.argv.includes('--guides')) {
  // every `tree` fence of every guide, built as the guide-samples gate builds one: alone, against the standard library.
  // A fence that does not build alone (a part of a program, one meant to fail) is left as it is
  const guides = path.join(parentRoot(), 'note/project/term/guides/draft')
  const resolve = projectResolver(TERM)
  const pages: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)

      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (name.endsWith('.md')) {
        pages.push(full)
      }
    }
  }

  walk(guides)

  for (const page of pages) {
    let markdown = readFileSync(page, 'utf8')
    const fences = [...markdown.matchAll(/```tree[^\n]*\n([\s\S]*?)```/g)]

    for (const fence of fences.reverse()) {
      const body = fence[1]!

      if (!WORDS.test(body)) {
        continue
      }

      const file = path.join(TERM, 'tmp', 'length-guide.tree')
      const build: Build = text => {
        const compiled = carriesTests(text) ? readable(text) : undefined

        return { result: compile({ file, text: compiled?.text ?? text }, { resolve, env: 'node' }), place: compiled?.place }
      }
      const line = markdown.slice(0, fence.index).split('\n').length

      record(`${path.relative(REPO, page)}:${line}`, migrate(file, body, build), text => {
        const start = fence.index! + fence[0].indexOf(body)
        markdown = `${markdown.slice(0, start)}${text}${markdown.slice(start + body.length)}`
      })
    }

    if (commit && markdown !== readFileSync(page, 'utf8')) {
      writeFileSync(page, markdown)
    }
  }
} else {
  // the packages, every folder under deck holding a deck.tree, and zone. `--only base,make` reads
  // those alone
  const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',')
  const roots = [
    ...readdirSync(path.join(TERM, 'deck'))
      .map(name => path.join(TERM, 'deck', name))
      .filter(dir => existsSync(path.join(dir, 'deck.tree'))),
    ...parentPaths('deck/zone'),
  ].filter(dir => existsSync(path.join(dir, 'deck.tree')) && (!only || only.includes(path.basename(dir))))

  for (const root of roots) {
    const resolve = projectResolver(root)
    const deckOf = projectDeckOf()
    const roleOf = projectRoleOf(root)
    const leanOf = projectLeanOf(root)

    for (const file of findTreeFiles(root, [], 'node')) {
      const source = readFileSync(file, 'utf8')
      const unit = buildable(file, source, roleOf(file))

      if ('faults' in unit || roleOf(file) === 'mill' || !WORDS.test(source)) {
        continue
      }

      // the text a file builds from, as `term make` reads it
      const build: Build = text => {
        const built = buildable(file, text, roleOf(file))
        const source = 'faults' in built ? text : built.text
        const compiled = carriesTests(source) ? readable(source) : undefined

        return { result: compile({ file, text: compiled?.text ?? source }, { resolve, deckOf, roleOf, leanOf, env: 'node' }), place: compiled?.place }
      }

      record(path.relative(REPO, file), migrate(file, source, build), text => writeFileSync(file, text))
    }
  }
}

console.log(`\nlength-migrate: ${texts} texts read, ${changed} with calls to move, ${calls} calls${commit ? '' : ' (report only: --commit writes)'}`)

if (aliasCalls.length > 0) {
  console.log(`\n${aliasCalls.length} calls to a text alias of text/string.tree (named, not moved):\n  ${aliasCalls.join('\n  ')}`)
}

if (unproven.length > 0) {
  console.log(`\n${unproven.length} not proven, left as they are:\n  ${unproven.join('\n  ')}`)
}

if (broken.length > 0) {
  console.log(`\n${broken.length} do not build before any change, left as they are:\n  ${broken.slice(0, 40).join('\n  ')}${broken.length > 40 ? `\n  and ${broken.length - 40} more` : ''}`)
}

process.exit(unproven.length > 0 ? 1 : 0)
