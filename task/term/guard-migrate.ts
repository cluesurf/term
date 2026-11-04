// The guarded block is a `fork` with `mark unsafe` on it (`pnpm term:guard-migrate`, 2026-10-06):
//
//   mark unsafe                fork
//     save answer, fetch(url)    mark unsafe
//   halt take                    save answer, fetch(url)
//     take problem             halt take
//                                take problem
//
// A metadata word never opens a block; a block is a `fork`. `note unsafe` over statements, the older spelling of the
// same guard, moves the same way. The statements under the guard are already its children beside the `unsafe` word,
// so the rewrite changes ONE line, the guard's own, into two, and every statement keeps its line and its indent.
//
// Each guard is found by the PARSER, never by matching text: a group headed `mark` or `note` whose next node is a bare
// `unsafe` and which holds statements after it. So a `mark unsafe` with nothing under it (a task's metadata), a
// comment and a text are never touched. Each changed file is proven by building to the same TypeScript before and
// after, byte for byte; a file that does not build before is changed only when it still fails after, and reported.
//
//   pnpm term:guard-migrate                  report every package's files
//   pnpm term:guard-migrate --commit         write each file whose proof holds
//   pnpm term:guard-migrate --guides         the guides' `tree` fences instead (each proven the same way, alone)
//
// Run from the Term root, where the `@term/*` paths resolve.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { parse, renderHead } from '@term/make/code/parser/tree'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { buildable, findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { carriesTests, readable } from '@term/call/code/test-preprocess'
import { TERM_ROOT, parentPaths, parentRoot } from './root'

const TERM = TERM_ROOT
const REPO = TERM_ROOT
const commit = process.argv.includes('--commit')

const head = (group: GroupNode): string | undefined => (group.nodes[0]?.kind === 'name' ? renderHead(group.nodes[0]) : undefined)

// the line of every guard: a `mark` or `note` group, then a bare `unsafe`, then at least one statement
function guardLines(text: string): number[] {
  const parsed = parse({ file: 'scan.tree', text })

  if (!parsed.ok) {
    return []
  }

  const found: number[] = []
  const visit = (node: unknown): void => {
    const one = node as { kind?: string; nodes?: unknown[] }

    if (one.kind !== 'group') {
      return
    }

    const group = node as GroupNode
    const word = head(group)
    const second = group.nodes[1] as GroupNode | undefined

    if (
      (word === 'mark' || word === 'note') &&
      second?.kind === 'group' &&
      head(second) === 'unsafe' &&
      second.nodes.length === 1 &&
      group.nodes.length > 2
    ) {
      const span = spanOfNode(group.nodes[0])

      if (span) {
        found.push(span.start.line)
      }
    }

    group.nodes.slice(1).forEach(visit)
  }

  parsed.tree.nodes.forEach(visit)

  return found
}

// the text with each guard line `<indent>mark unsafe` written `<indent>fork` / `<indent>  mark unsafe`
function rewrite(text: string): { text: string; count: number } {
  const lines = text.split('\n')
  let count = 0

  for (const at of guardLines(text).sort((a, b) => b - a)) {
    const line = lines[at]!
    const shape = /^(\s*)(mark|note) unsafe\s*$/.exec(line)

    // a guard line holding anything else (a comment after it) is left for a person, and reported by the count
    if (shape) {
      lines.splice(at, 1, `${shape[1]}fork`, `${shape[1]}  mark unsafe`)
      count++
    }
  }

  return { text: lines.join('\n'), count }
}

let texts = 0
let changed = 0
let guards = 0
const unproven: string[] = []

function migrate(where: string, text: string, build: (text: string) => ReturnType<typeof compile>, write: (text: string) => void): void {
  const next = rewrite(text)

  texts++

  if (next.count === 0) {
    return
  }

  const before = build(text)
  const after = build(next.text)
  // the rewrite adds a line, so in a TEST file every `want` after it is tagged with a line one later
  // (call/code/test-preprocess.ts: `want-left-<line>`, `want:<line>`, `line <n> did not hold`): those tags, and only
  // those, are read without their number. Every other byte must be the same
  const untagged = (typescript: string): string =>
    carriesTests(text) ? typescript.replace(/(want(?:Left|Right|Snapshot)|want:|want-(?:left|right|snapshot)-|line )\d+/g, '$1#') : typescript
  const proven = before.ok ? after.ok && untagged(after.typescript) === untagged(before.typescript) : !after.ok

  changed++
  guards += next.count

  if (!proven) {
    unproven.push(`${where} (${after.ok ? 'the TypeScript differs' : `does not build after: ${after.diagnostics[0]?.message ?? ''}`})`)
    return
  }

  console.log(`${commit ? 'wrote ' : 'would '}${where}: ${next.count} guard${next.count === 1 ? '' : 's'}${before.ok ? '' : ' (did not build before, and does not after)'}`)

  if (commit) {
    write(next.text)
  }
}

const tested = (text: string): string => (carriesTests(text) ? readable(text).text : text)

if (process.argv.includes('--guides')) {
  const resolve = projectResolver(TERM)
  const file = path.join(TERM, 'tmp', 'guard-guide.tree')
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

  walk(path.join(parentRoot(), 'note/project/term/guides/draft'))

  for (const page of pages) {
    let markdown = readFileSync(page, 'utf8')

    for (const fence of [...markdown.matchAll(/```tree[^\n]*\n([\s\S]*?)```/g)].reverse()) {
      const body = fence[1]!
      const line = markdown.slice(0, fence.index).split('\n').length

      migrate(`${path.relative(REPO, page)}:${line}`, body, text => compile({ file, text: tested(text) }, { resolve, env: 'node' }), text => {
        const start = fence.index! + fence[0].indexOf(body)
        markdown = `${markdown.slice(0, start)}${text}${markdown.slice(start + body.length)}`
      })
    }

    if (commit && markdown !== readFileSync(page, 'utf8')) {
      writeFileSync(page, markdown)
    }
  }
} else {
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

    for (const file of findTreeFiles(root)) {
      const source = readFileSync(file, 'utf8')

      // a cheap filter only: the parser decides which line is a guard
      if (!/^\s*(mark|note) unsafe\s*$/m.test(source)) {
        continue
      }

      const build = (text: string) => {
        const unit = buildable(file, text, roleOf(file))

        return compile({ file, text: tested('faults' in unit ? text : unit.text) }, { resolve, deckOf, roleOf, leanOf, env: 'node' })
      }

      migrate(path.relative(REPO, file), source, build, text => writeFileSync(file, text))
    }
  }
}

console.log(`\nguard-migrate: ${texts} texts read, ${changed} changed, ${guards} guards${commit ? '' : ' (report only: --commit writes)'}`)

if (unproven.length > 0) {
  console.log(`\n${unproven.length} not proven, left as they are:\n  ${unproven.join('\n  ')}`)
}

process.exit(unproven.length > 0 ? 1 : 0)
