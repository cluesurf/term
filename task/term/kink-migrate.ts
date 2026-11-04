// Every call L041 (`unhandled-raise`) flags gets a `halt kink` under it (`pnpm term:kink-migrate`, term-compiler-0016,
// decision 002 of note/project/term/compiler): the call already passes the callee's exception on, on every backend, and
// `halt kink` only says so, so the census of L041 can reach zero before the checker refuses the call (term-compiler-0017).
//
//   call refuse-time                  call refuse-time
//     text <a dash must follow>         text <a dash must follow>
//                                       halt kink
//
// Each call is the one the LINT rule reported, by its span, never a text match. A call that heads its own line gets
// `halt kink` as its last child, at its indent plus two, after every line of its subtree. A call that is a head's whole
// value (`save y, f(x)`, `back f(x)`, `sift f(x)`) is first given a line of its own under that head. A call anywhere
// else (an argument of another call) has no line to hang a child on, and is reported, never rewritten. Each changed
// file is proven by building to the same TypeScript AND Rust
// before and after, byte for byte (a test file's line tags read without their number, as guard-migrate does), and by
// the lint no longer flagging the calls that moved.
//
//   pnpm term:kink-migrate                     report every package's files
//   pnpm term:kink-migrate --commit            write each file whose proof holds
//   pnpm term:kink-migrate --only <dir>        one package (a folder name under deck, or zone)
//
// Run from the Term root, where the `@term/*` paths resolve.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { analyze } from '@term/make/code/analyze'
import { buildable, findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { carriesTests, readable } from '@term/call/code/test-preprocess'
import { TERM_ROOT, parentPaths, parentRoot } from './root'

const TERM = TERM_ROOT
const REPO = TERM_ROOT
const commit = process.argv.includes('--commit')
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined

type Readers = { role: ReturnType<ReturnType<typeof projectRoleOf>>; lean: ReturnType<ReturnType<typeof projectLeanOf>> }

// the 0-based line and column of every L041 call in the file
function flagged(file: string, text: string, readers: Readers): { line: number; column: number }[] {
  return analyze({ file, text }, readers)
    .lint()
    .filter(finding => finding.code === 'L041')
    .map(finding => ({ line: finding.span.start.line, column: finding.span.start.column }))
}

const indentOf = (line: string): number => line.length - line.trimStart().length

// the text with `halt kink` under each flagged call that heads its own line, and the calls left inside a line
function rewrite(text: string, calls: { line: number; column: number }[]): { text: string; moved: number; inline: number } {
  const lines = text.split('\n')
  let moved = 0
  let inline = 0
  // bottom up, so an insertion never shifts a line still to be read
  const ordered = [...new Map(calls.map(c => [`${c.line}:${c.column}`, c])).values()].sort((a, b) => b.line - a.line || b.column - a.column)

  for (const call of ordered) {
    const line = lines[call.line]

    if (line === undefined || line.trim().length === 0) {
      inline++
      continue
    }

    // THE CALL IS A HEAD'S VALUE: `save found, read-tokens(a, b)`, `back f(x)`, `sift f(x)`, `fork case, f(x)`. The value
    // takes a line of its own under the head, and `halt kink` goes under it:
    //
    //   save found, read-tokens(a, b)        save found
    //                                          read-tokens(a, b)
    //                                            halt kink
    //
    // only when the call runs to the end of the line, and the head has no children of its own (a `sift` and a
    // `fork case` keep their arms, which follow the value as they followed the head)
    if (indentOf(line) !== call.column) {
      const prefix = line.slice(0, call.column)
      const value = line.slice(call.column)
      const head = /^(\s*)(save [^\s,]+|host [^\s,]+|send back|back|sift|fork case)(,\s*|\s+)$/.exec(prefix)
      let depth = 0
      let closes = -1

      for (let at = 0; at < value.length; at++) {
        if (value[at] === '(') depth++
        if (value[at] === ')' && --depth === 0) closes = at
      }

      const below = lines[call.line + 1]
      const children = below !== undefined && below.trim().length > 0 && indentOf(below) > indentOf(line)
      const arms = head?.[2] === 'sift' || head?.[2] === 'fork case'

      if (!head || closes !== value.trimEnd().length - 1 || (children && !arms) || (head[2] === 'sift' && !/^\s*sift\s/.test(prefix))) {
        inline++
        continue
      }

      const indent = head[1]!
      lines.splice(call.line, 1, `${indent}${head[2]}`, `${indent}  ${value.trimEnd()}`, `${indent}    halt kink`)
      moved++
      continue
    }

    // the call's subtree: every following line indented past it (blank lines inside it kept with it)
    let last = call.line

    for (let at = call.line + 1; at < lines.length; at++) {
      const next = lines[at]!

      if (next.trim().length === 0) {
        continue
      }

      if (indentOf(next) <= call.column) {
        break
      }

      last = at
    }

    lines.splice(last + 1, 0, `${' '.repeat(call.column + 2)}halt kink`)
    moved++
  }

  return { text: lines.join('\n'), moved, inline }
}

// a file another session owns (note/project/workflow/locks.json, mode owned) is never written: the hook that refuses
// an Edit there does not see a script's write, so the script asks the same table itself, and reports the file instead
const LOCKED: string[] = (() => {
  const table = path.join(parentRoot(), 'note/project/workflow/locks.json')

  if (!existsSync(table)) {
    return []
  }

  const locks = (JSON.parse(readFileSync(table, 'utf8')) as { lock?: { path: string; mode?: string }[] }).lock ?? []

  return locks.filter(lock => lock.mode === 'owned').map(lock => lock.path)
})()
const lockedAt: string[] = []

let read = 0
let changed = 0
let movedAll = 0
let inlineAll = 0
let flaggedAll = 0
const unproven: string[] = []
const inlineAt: string[] = []

const tested = (text: string): string => (carriesTests(text) ? readable(text).text : text)
// the rewrite adds lines, so in a TEST file every `want` after one is tagged with a later line: those tags, and only
// those, are read without their number
const untagged = (text: string, out: string): string =>
  carriesTests(text) ? out.replace(/(want(?:Left|Right|Snapshot)|want:|want-(?:left|right|snapshot)-|line )\d+/g, '$1#') : out

const roots = [
  ...readdirSync(path.join(TERM, 'deck'))
    .map(name => path.join(TERM, 'deck', name))
    .filter(dir => existsSync(path.join(dir, 'deck.tree'))),
  ...parentPaths('deck/zone'),
].filter(root => !only || path.basename(root) === only)

for (const root of roots) {
  const resolve = projectResolver(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)

  for (const file of findTreeFiles(root)) {
    const source = readFileSync(file, 'utf8')
    const readers = { role: roleOf(file), lean: leanOf(file) }
    const where = path.relative(REPO, file)

    read++

    let calls: { line: number; column: number }[]

    try {
      calls = flagged(path.relative(root, file), source, readers)
    } catch (error) {
      unproven.push(`${where} (the lint threw: ${String(error).slice(0, 120)})`)
      continue
    }

    if (calls.length === 0) {
      continue
    }

    flaggedAll += calls.length
    const next = rewrite(source, calls)
    inlineAll += next.inline

    if (next.inline > 0) {
      inlineAt.push(`${where}: ${next.inline}`)
    }

    if (next.moved === 0) {
      continue
    }

    const build = (text: string) => {
      const unit = buildable(file, text, roleOf(file))
      const result = compile({ file, text: tested('faults' in unit ? text : unit.text) }, { resolve, deckOf, roleOf, leanOf, env: 'node' })

      return result.ok ? { ok: true as const, typescript: untagged(text, result.typescript), rust: untagged(text, emitRust(result.program)) } : { ok: false as const, why: result.diagnostics[0]?.message ?? '' }
    }

    const before = build(source)
    const after = build(next.text)
    const same = before.ok ? after.ok && after.typescript === before.typescript && after.rust === before.rust : !after.ok
    // the moved calls are no longer flagged: what is left is exactly the calls left inside a line
    const left = flagged(path.relative(root, file), next.text, readers).length
    const proven = same && left === next.inline

    if (!proven) {
      unproven.push(
        `${where} (${!same ? (after.ok ? 'the TypeScript or Rust differs' : `does not build after: ${(after as { why: string }).why}`) : `${left} still flagged, ${next.inline} expected`})`,
      )
      continue
    }

    if (LOCKED.some(prefix => where === prefix || where.startsWith(prefix))) {
      lockedAt.push(`${where}: ${next.moved}`)
      continue
    }

    changed++
    movedAll += next.moved
    console.log(`${commit ? 'wrote ' : 'would '}${where}: ${next.moved} halt kink${before.ok ? '' : ' (did not build before, and does not after)'}`)

    if (commit) {
      writeFileSync(file, next.text)
    }
  }
}

console.log(
  `\nkink-migrate: ${read} files read, ${flaggedAll} calls flagged, ${movedAll} given halt kink in ${changed} files, ${inlineAll} inside a line${commit ? '' : ' (report only: --commit writes)'}`,
)

if (lockedAt.length > 0) {
  console.log(`\nproven but owned by another session (locks.json), left for its owner:\n  ${lockedAt.join('\n  ')}`)
}

if (inlineAt.length > 0) {
  console.log(`\ncalls inside a line, left for a person:\n  ${inlineAt.join('\n  ')}`)
}

if (unproven.length > 0) {
  console.log(`\n${unproven.length} not proven, left as they are:\n  ${unproven.join('\n  ')}`)
}

process.exit(unproven.length > 0 ? 1 : 0)
