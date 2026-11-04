// `take options, like maybe` with `like or` on the next line, two deeper, reads as TWO types of the take, because a
// child line belongs to the head of the line above and never to the last word on it. The bridge read the first and
// dropped the second in silence, so `maybe or boolean listener-options` was a bare `maybe`. Since 2026-10-06 the
// second is refused by name (mint-bridge.ts `refuseSiblingLikes`), and this moves the repository: the type goes on
// its own line and every `like` child of the owner moves under it, which is where its author meant it.
//
//     take options, like maybe          take options
//       like or                  ->       like maybe
//         like native-boolean               like or
//                                             like native-boolean
//
// A `like task` keeps its second `like`, which is the function's result, and a field with a native `name <X>`
// keeps it too, because there the trailing `like` is ignored by design (quirk 6). Each rewritten file is proven by
// its parse: the new tree is the old one with exactly those `like` subtrees moved under the owner's first `like`.
//
// Reports by default, writes on --commit. pnpm term:like-nest-migrate [--commit] [folders...]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse, renderHead } from '@term/make/code/parser/tree'
import { TERM_ROOT, parentPaths } from './root'

// the pnpm script runs this from the Term root
const TERM = TERM_ROOT
const SKIP = new Set(['node_modules', 'host', 'tmp', '.git', '.base', 'link'])
const commit = process.argv.includes('--commit')
const roots = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const folders = roots.length > 0 ? roots.map(root => resolve(root)) : [join(TERM, 'deck'), join(TERM, 'test'), ...parentPaths('deck/zone')]

// one line that owns a parameter or field and names its type after a comma, with nothing after the type
const OWNER = /^(\s*)(take|link|slot) ([^\s,]+), like ([^\s,]+)$/
// the same owner with its type on the next line, `take tells` / `like list` / `like dynamic`
const BARE = /^(\s*)(take|link|slot) ([^\s,]+)$/

function depthOf(line: string): number {
  return /^\s*/.exec(line)![0].length
}

// the end (exclusive) of the block of lines under line `i`
function blockEnd(lines: string[], i: number): number {
  const depth = depthOf(lines[i]!)
  let end = i + 1

  while (end < lines.length && (lines[end]!.trim() === '' || depthOf(lines[end]!) > depth)) {
    end++
  }

  // trailing blank lines belong to whatever follows
  while (end > i + 1 && lines[end - 1]!.trim() === '') {
    end--
  }

  return end
}

function rewrite(text: string): { text: string; count: number } {
  const lines = text.split('\n')
  const out: string[] = []
  let count = 0
  let i = 0

  while (i < lines.length) {
    const owner = OWNER.exec(lines[i]!)
    const bare = BARE.exec(lines[i]!)
    const end = blockEnd(lines, i)

    if (bare) {
      const moved = nestStacked(lines, i, end, bare[1]!.length)

      if (moved) {
        out.push(lines[i]!, ...moved)
        count++
        i = end
        continue
      }
    }

    if (!owner || owner[4] === 'task') {
      out.push(lines[i]!)
      i++
      continue
    }

    const depth = owner[1]!.length
    const kids: Array<{ start: number; end: number; like: boolean }> = []

    for (let j = i + 1; j < end; ) {
      if (lines[j]!.trim() === '') {
        j++
        continue
      }

      const kidEnd = blockEnd(lines, j)
      kids.push({ start: j, end: kidEnd, like: depthOf(lines[j]!) === depth + 2 && lines[j]!.trim().startsWith('like ') })
      j = kidEnd
    }

    if (!kids.some(kid => kid.like)) {
      out.push(lines[i]!)
      i++
      continue
    }

    count++
    out.push(`${owner[1]}${owner[2]} ${owner[3]}`)
    out.push(`${owner[1]}  like ${owner[4]}`)

    // the `like` children move under the type, in order, and every other child stays where it was, after them
    for (const kid of kids.filter(one => one.like)) {
      for (let j = kid.start; j < kid.end; j++) {
        out.push(lines[j]!.trim() === '' ? lines[j]! : `  ${lines[j]}`)
      }
    }

    for (const kid of kids.filter(one => !one.like)) {
      for (let j = kid.start; j < kid.end; j++) {
        out.push(lines[j]!)
      }
    }

    i = end
  }

  return { text: out.join('\n'), count }
}

// The children of a bare owner, its `like` children after the first moved under the first: the lines that replace
// lines i+1 .. end, or undefined when there is nothing to move (one `like`, or a `like task` whose second is its
// result, or a native `name <X>` beside it).
function nestStacked(lines: string[], i: number, end: number, depth: number): string[] | undefined {
  const kids: Array<{ start: number; end: number; like: boolean }> = []

  for (let j = i + 1; j < end; ) {
    if (lines[j]!.trim() === '') {
      j++
      continue
    }

    const kidEnd = blockEnd(lines, j)
    kids.push({ start: j, end: kidEnd, like: depthOf(lines[j]!) === depth + 2 && lines[j]!.trim().startsWith('like ') })
    j = kidEnd
  }

  const likes = kids.filter(kid => kid.like)
  const native = kids.some(kid => lines[kid.start]!.trim().startsWith('name <'))
  const firstType = likes[0] ? lines[likes[0].start]!.trim().split(/[\s,]+/)[1] : undefined

  if (likes.length < 2 || native || firstType === 'task') {
    return undefined
  }

  const out: string[] = []
  const block = (kid: { start: number; end: number }, indent: string): void => {
    for (let j = kid.start; j < kid.end; j++) {
      out.push(lines[j]!.trim() === '' ? lines[j]! : `${indent}${lines[j]}`)
    }
  }

  for (const kid of kids) {
    if (kid === likes[0]) {
      block(kid, '')
      likes.slice(1).forEach(extra => block(extra, '  '))
    } else if (!kid.like) {
      block(kid, '')
    }
  }

  return out
}

// a parse reduced to what the proof compares: heads and children, no spans
type Shape = unknown

function shapeOf(node: any): Shape {
  if (node === null || typeof node !== 'object') {
    return node
  }

  if (Array.isArray(node)) {
    return node.map(shapeOf)
  }

  const out: Record<string, Shape> = {}

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'span' && key !== 'range' && key !== 'start' && key !== 'end' && key !== 'offset' && key !== 'line' && key !== 'column') {
      out[key] = shapeOf(value)
    }
  }

  return out
}

// the proof: parse the OLD text, move each owner's extra `like` groups under its first `like` in the tree itself,
// and require that to equal the parse of the new text
function moveLikes(node: any): void {
  if (node === null || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    node.forEach(moveLikes)

    return
  }

  if (node.kind === 'group' && Array.isArray(node.nodes)) {
    const head = node.nodes[0]
    const word = head?.kind === 'name' ? headWord(head) : undefined

    if (word === 'take' || word === 'link' || word === 'slot') {
      const likes = node.nodes.filter((child: any) => child?.kind === 'group' && headWord(child.nodes?.[0]) === 'like')
      const first = likes[0]
      const firstType = first ? headWord(first.nodes?.[1]?.kind === 'group' ? first.nodes[1].nodes?.[0] : first.nodes?.[1]) : undefined

      // nodes[1] is the owner's own name, which may itself be `name` (`take name, like maybe`)
      const native = node.nodes.slice(2).some((child: any) => child?.kind === 'group' && headWord(child.nodes?.[0]) === 'name')

      if (likes.length > 1 && firstType !== 'task' && !native) {
        const extra = likes.slice(1)
        node.nodes = node.nodes.filter((child: any) => !extra.includes(child))
        first.nodes.push(...extra)
      }
    }

  }

  if (Array.isArray(node.nodes)) {
    node.nodes.forEach(moveLikes)
  }
}

function headWord(node: any): string | undefined {
  return node?.kind === 'name' ? renderHead(node) : undefined
}

function proven(file: string, before: string, after: string): string | undefined {
  const old = parse({ file, text: before }) as any
  const now = parse({ file, text: after }) as any

  if (!old.ok || !now.ok) {
    return old.ok ? 'the rewrite does not parse' : undefined
  }

  moveLikes(old.tree)

  const a = JSON.stringify(shapeOf(old.tree))
  const b = JSON.stringify(shapeOf(now.tree))

  if (a === b) {
    return undefined
  }

  let at = 0

  while (a[at] === b[at]) {
    at++
  }

  return `the parse differs at ${at}: ${a.slice(at - 120, at + 80)}  ||  ${b.slice(at - 120, at + 80)}`
}

let files = 0
let sites = 0
const refused: string[] = []

function walk(dir: string): void {
  if (!statSync(dir).isDirectory()) {
    visit(dir)

    return
  }

  for (const name of readdirSync(dir)) {
    const full = join(dir, name)

    if (SKIP.has(name) || name.startsWith('.env')) {
      continue
    }

    if (statSync(full).isDirectory()) {
      walk(full)
    } else if (name.endsWith('.tree')) {
      visit(full)
    }
  }
}

function visit(full: string): void {
  const before = readFileSync(full, 'utf8')
  const { text: after, count } = rewrite(before)

  if (count === 0) {
    return
  }

  const problem = proven(full, before, after)

  if (problem) {
    refused.push(`${full}: ${problem}`)

    return
  }

  files++
  sites += count

  if (commit) {
    writeFileSync(full, after)
  }
}

folders.forEach(walk)
console.log(`${sites} owners in ${files} files ${commit ? 'rewritten' : 'to rewrite (--commit writes)'}`)

for (const line of refused.slice(0, 40)) {
  console.log(`not proven  ${line}`)
}

if (refused.length > 0) {
  console.log(`${refused.length} files not proven, left alone`)
  process.exitCode = 1
}
