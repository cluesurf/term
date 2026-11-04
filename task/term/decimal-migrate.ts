// `like decimal` becomes `like float` (`pnpm term:decimal-migrate`), note/project/term/decisions-2026-10/decisions-2026-10.md, D4.
//
// `decimal` named two things: the type word `like decimal`, which is the platform float, and the `decimal` module,
// which is exact base 10 (`big-decimal`). "decimal" means base 10 in every other language's library, so the type word
// goes: `like float` says what it is, and `like decimal` is refused, naming `like float` (check/infer.ts, the type
// names). This rewrites every `like decimal` in the repository first.
//
// Each `decimal` is found by the PARSER, as the bare word that heads a group under a `like` group, never by matching
// text, so a comment, a text literal or the `decimal` module's name is never touched. The two words seed to the one
// type (compile/surface.tree `primitive-of`), so the proof is the strongest one there is: each changed file builds to
// the same TypeScript before and after, byte for byte. A file that does not build before is changed only when it
// still parses, and reported.
//
//   pnpm term:decimal-migrate                     report every package's files
//   pnpm term:decimal-migrate --commit            write each file whose proof holds
//   pnpm term:decimal-migrate --guides            the guides' `tree` fences instead (each proven the same way, alone)
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
import type { Span } from '@term/make/code/parser/diagnostic'
import { TERM_ROOT, parentPaths, parentRoot } from './root'

const TERM = TERM_ROOT
const REPO = TERM_ROOT
const commit = process.argv.includes('--commit')

const head = (group: GroupNode): string | undefined => (group.nodes[0]?.kind === 'name' ? renderHead(group.nodes[0]) : undefined)

// the spans of every `decimal` that is a type word: the head of a group, alone in it, anywhere under a `like` group
function decimalWords(text: string): Span[] {
  const parsed = parse({ file: 'scan.tree', text })

  if (!parsed.ok) {
    return []
  }

  const found: Span[] = []
  const visit = (node: unknown, underLike: boolean): void => {
    const one = node as { kind?: string; nodes?: unknown[]; parts?: unknown[]; group?: unknown }

    if (one.kind === 'group') {
      const group = node as GroupNode
      const word = head(group)

      if (underLike && word === 'decimal' && group.nodes.length === 1) {
        const span = spanOfNode(group.nodes[0])

        if (span) {
          found.push(span)
        }
      }

      // everything under a `like` is a type, at any depth: `like signal decimal` is like > signal > decimal, and
      // `like maybe / head decimal` puts it under a `head`. Only a text or an interpolation leaves the type
      group.nodes.slice(1).forEach(child => visit(child, underLike || word === 'like'))
    } else if (one.kind === 'text' || one.kind === 'name') {
      one.parts?.forEach(part => visit(part, false))
    } else if (one.kind === 'interpolation' && one.group) {
      visit(one.group, false)
    }
  }

  parsed.tree.nodes.forEach(node => visit(node, false))

  return found
}

// the text with every type word `decimal` written `float`
function rewrite(text: string): { text: string; count: number } {
  const lines = text.split('\n')
  const spans = decimalWords(text).sort((a, b) => b.start.line - a.start.line || b.start.column - a.start.column)

  for (const span of spans) {
    const line = lines[span.start.line]!

    // the span is the word itself; a span that does not hold the word is not rewritten
    if (line.slice(span.start.column, span.start.column + 7) === 'decimal') {
      lines[span.start.line] = `${line.slice(0, span.start.column)}float${line.slice(span.start.column + 7)}`
    }
  }

  return { text: lines.join('\n'), count: spans.length }
}

let texts = 0
let changed = 0
let words = 0
const unproven: string[] = []

// one text: rewritten, and proven by building both to TypeScript where the old one builds
function migrate(where: string, text: string, build: (text: string) => ReturnType<typeof compile>, write: (text: string) => void): void {
  const next = rewrite(text)

  texts++

  if (next.count === 0 || next.text === text) {
    return
  }

  const before = build(text)
  const after = build(next.text)
  // a file that did not build before is held to building no worse: it fails, or it builds, as it did. Once the
  // refusal is in, a file that failed ONLY on it must build after: the two words were one type until then
  const onlyTheWord =
    !before.ok && before.diagnostics.length > 0 && before.diagnostics.every(d => /`like decimal` is the old name of `like float`/.test(d.message))
  const proven = before.ok ? after.ok && after.typescript === before.typescript : onlyTheWord ? after.ok : !after.ok

  changed++
  words += next.count

  if (!proven) {
    unproven.push(`${where} (${after.ok ? 'the TypeScript differs' : `does not build after: ${after.diagnostics[0]?.message ?? ''}`})`)
    return
  }

  console.log(
    `${commit ? 'wrote ' : 'would '}${where}: ${next.count} word${next.count === 1 ? '' : 's'}${
      before.ok ? '' : onlyTheWord ? ' (refused only for the word before, builds after)' : ' (did not build before, and does not after)'
    }`,
  )

  if (commit) {
    write(next.text)
  }
}

const tested = (text: string): string => (carriesTests(text) ? readable(text).text : text)

if (process.argv.includes('--guides')) {
  const resolve = projectResolver(TERM)
  const file = path.join(TERM, 'tmp', 'decimal-guide.tree')
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

    // every .tree file holding the word, each platform's native files too
    for (const file of findTreeFiles(root)) {
      const source = readFileSync(file, 'utf8')

      // a cheap filter only: the parser decides which `decimal` is a type word (`like signal decimal` is one)
      if (!/\bdecimal\b/.test(source)) {
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

console.log(`\ndecimal-migrate: ${texts} texts read, ${changed} changed, ${words} words${commit ? '' : ' (report only: --commit writes)'}`)

if (unproven.length > 0) {
  console.log(`\n${unproven.length} not proven, left as they are:\n  ${unproven.join('\n  ')}`)
}

process.exit(unproven.length > 0 ? 1 : 0)
