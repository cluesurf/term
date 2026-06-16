// The tree builder. The sift stream to the TreeLine AST, using a wall of slabs (a stack of nesting contexts).
// Each node attaches under the head of its line. Faithful port of @cluesurf/tree's tree pass. Browser-safe:
// no node APIs, pure data transformation.

import type { Band, Diagnostic } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type { Leaf } from '@/code/parser/leaf'
import { makeLeafList } from '@/code/parser/leaf'
import type { Sift } from '@/code/parser/sift'
import { SiftName, makeSiftList } from '@/code/parser/sift'

export enum TreeName {
  Comb = 'tree-comb',
  Code = 'tree-code',
  Knit = 'tree-knit',
  Nick = 'tree-nick',
  Text = 'tree-text',
  Cord = 'tree-cord',
  Fork = 'tree-fork',
  Size = 'tree-size',
  Line = 'tree-line',
}

export type TreeLine = { form: TreeName.Line; nest: Array<TreeFork> }

export type TreeFork = {
  form: TreeName.Fork
  nest: Array<TreeFork | TreeText | TreeSize | TreeCord | TreeNick | TreeComb | TreeCode | TreeKnit>
  base?: TreeFork | TreeNick
  optional?: boolean
}

export type TreeKnit = { form: TreeName.Knit; nest: Array<TreeNick | TreeCord>; base?: TreeFork }
export type TreeText = { form: TreeName.Text; nest: Array<TreeCord | TreeNick>; base?: TreeFork }
export type TreeNick = { form: TreeName.Nick; size: number; nest?: TreeFork; base?: TreeKnit | TreeText }
export type TreeCord = { form: TreeName.Cord; text: string; leaf: Leaf; base?: TreeText | TreeKnit }
export type TreeSize = { form: TreeName.Size; bond: number; leaf: Leaf; base?: TreeFork }
export type TreeComb = { form: TreeName.Comb; bond: number; leaf: Leaf; base?: TreeFork }
export type TreeCode = { form: TreeName.Code; bond: number; mold: string; leaf: Leaf; base?: TreeFork }

export type Tree =
  | TreeLine
  | TreeFork
  | TreeKnit
  | TreeText
  | TreeNick
  | TreeCord
  | TreeSize
  | TreeComb
  | TreeCode

export type TreeResult =
  | { ok: true; tree: TreeLine }
  | { ok: false; diagnostics: Array<Diagnostic> }

type Slab = { line: Array<Tree>; nest: Array<Tree>; slot: number }

function readSiftTree(
  siftList: Array<Sift>,
  file: string,
  diagnostics: Array<Diagnostic>,
): TreeLine {
  const tree: TreeLine = { form: TreeName.Line, nest: [] }
  const slab: Slab = { line: [tree], nest: [tree], slot: 0 }
  const wall: Array<Slab> = [slab]

  function top(): Slab {
    return wall[wall.length - 1]!
  }
  function base(): Tree {
    const s = top()
    return s.line[s.line.length - 1]!
  }
  function takeSlab(s: Slab, head: Tree) {
    if (s.line.length === 2) {
      s.nest = s.nest.slice(0, s.slot + 1)
      s.nest.push(head)
    }
  }
  function unexpected(seed: Sift) {
    const leaf = 'leaf' in seed ? (seed.leaf as Leaf) : undefined
    diagnostics.push(
      diagnose('unexpected-node', {
        file,
        band: leaf ? leaf.band : zeroBand(),
        note: `unexpected ${seed.form} here`,
      }),
    )
  }

  for (const seed of siftList) {
    switch (seed.form) {
      case SiftName.RiseFork: {
        const b = base()
        if (b.form === TreeName.Line || b.form === TreeName.Fork) {
          const fork: TreeFork = { form: TreeName.Fork, nest: [], base: b }
          b.nest.push(fork)
          top().line.push(fork)
          takeSlab(top(), fork)
        } else if (b.form === TreeName.Nick) {
          const fork: TreeFork = { form: TreeName.Fork, nest: [], base: b }
          b.nest = fork
          top().line.push(fork)
          takeSlab(top(), fork)
        } else {
          unexpected(seed)
        }
        break
      }
      case SiftName.FallFork:
      case SiftName.FallKnit:
      case SiftName.FallText:
        top().line.pop()
        break
      case SiftName.RiseKnit: {
        const b = base()
        if (b.form === TreeName.Fork) {
          const knit: TreeKnit = { form: TreeName.Knit, nest: [], base: b }
          b.nest.push(knit)
          top().line.push(knit)
          takeSlab(top(), knit)
        } else {
          unexpected(seed)
        }
        break
      }
      case SiftName.RiseText: {
        const b = base()
        if (b.form === TreeName.Fork) {
          const text: TreeText = { form: TreeName.Text, nest: [], base: b }
          b.nest.push(text)
          top().line.push(text)
        } else {
          unexpected(seed)
        }
        break
      }
      case SiftName.RiseNick: {
        const b = base()
        if (b.form === TreeName.Knit || b.form === TreeName.Text) {
          const nick: TreeNick = { form: TreeName.Nick, size: seed.size, base: b }
          b.nest.push(nick)
          wall.push({ line: [nick], nest: [nick], slot: 0 })
        } else {
          unexpected(seed)
        }
        break
      }
      case SiftName.FallNick:
        wall.pop()
        break
      case SiftName.Cord: {
        const b = base()
        if (b.form === TreeName.Knit) {
          const leaf = seed.leaf
          const hasOptional = leaf.text.includes('?')
          const cord: TreeCord = {
            form: TreeName.Cord,
            text: hasOptional ? leaf.text.replace(/\?/g, '') : leaf.text,
            leaf,
            base: b,
          }
          b.nest.push(cord)
          if (hasOptional && b.base) b.base.optional = true
        } else if (b.form === TreeName.Text) {
          b.nest.push({ form: TreeName.Cord, text: seed.leaf.text, leaf: seed.leaf, base: b })
        } else {
          unexpected(seed)
        }
        break
      }
      case SiftName.Size: {
        const b = base()
        if (b.form === TreeName.Fork) {
          b.nest.push({ form: TreeName.Size, bond: seed.bond, leaf: seed.leaf, base: b })
        } else if (b.form === TreeName.Line) {
          diagnostics.push(
            diagnose('invalid-nesting', {
              file,
              band: seed.leaf.band,
              hint: 'a bare number is a size, not a term, so it cannot be the head of a line',
            }),
          )
        } else {
          unexpected(seed)
        }
        break
      }
      case SiftName.Comb: {
        const b = base()
        if (b.form === TreeName.Fork) {
          b.nest.push({ form: TreeName.Comb, bond: seed.bond, leaf: seed.leaf, base: b })
        } else {
          unexpected(seed)
        }
        break
      }
      case SiftName.Code: {
        const b = base()
        if (b.form === TreeName.Fork) {
          b.nest.push({ form: TreeName.Code, bond: seed.bond, mold: seed.mold, leaf: seed.leaf, base: b })
        } else {
          unexpected(seed)
        }
        break
      }
      case SiftName.RiseNest: {
        const s = top()
        s.slot++
        s.line = [s.nest[s.slot]!]
        break
      }
      case SiftName.FallNest: {
        const s = top()
        s.slot--
        s.line = [s.nest[s.slot]!]
        break
      }
      default:
        break
    }
  }

  return tree
}

function zeroBand(): Band {
  return { base: { line: 0, mark: 0 }, head: { line: 0, mark: 0 } }
}

// The strict entry. Parse text to a tree, or return diagnostics.
export function makeTree(link: { file: string; text: string }): TreeResult {
  const leafResult = makeLeafList(link)
  if (!leafResult.ok) return { ok: false, diagnostics: leafResult.diagnostics }

  const siftResult = makeSiftList(leafResult.cast)
  if (!siftResult.ok) return { ok: false, diagnostics: siftResult.diagnostics }

  const diagnostics: Array<Diagnostic> = []
  const tree = readSiftTree(siftResult.cast.siftList, link.file, diagnostics)
  if (diagnostics.length) return { ok: false, diagnostics }
  return { ok: true, tree }
}

// The tolerant entry. Never fails. Returns whatever tree it built plus any diagnostics. For the language server.
export function makeTreeTolerant(link: { file: string; text: string }): { tree: TreeLine; diagnostics: Array<Diagnostic> } {
  const empty: TreeLine = { form: TreeName.Line, nest: [] }
  const leafResult = makeLeafList(link)
  if (!leafResult.ok) return { tree: empty, diagnostics: leafResult.diagnostics }
  const siftResult = makeSiftList(leafResult.cast)
  if (!siftResult.ok) return { tree: empty, diagnostics: siftResult.diagnostics }
  const diagnostics: Array<Diagnostic> = []
  const tree = readSiftTree(siftResult.cast.siftList, link.file, diagnostics)
  return { tree, diagnostics }
}
