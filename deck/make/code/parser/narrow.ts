// The concrete tree's kinds by name, for the readers still written in TypeScript.
//
// parser/tree.tree's `node` form emits ONE union, `Node`, and types a group's `nodes`, a name's `parts` and an
// interpolation's `group` as `Node`, because a Term form cannot hold a list of some of its cases. A Term reader sifts on
// the kind. A TypeScript reader wants `GroupNode` and the rest, so they are here, narrowed from the union, with the
// guards that narrow a value to one. This module goes when the last TypeScript reader of the tree does.

import type { Node, RootNode } from '@term/make/code/parser/tree'

// the root is a form of its own, never a child, so a reader takes it from parser/tree; it is named here as well so a
// reader takes every kind from one place
export type { RootNode }
export type GroupNode = Extract<Node, { kind: 'group' }>
export type NameNode = Extract<Node, { kind: 'name' }>
export type TextNode = Extract<Node, { kind: 'text' }>
export type InterpolationNode = Extract<Node, { kind: 'interpolation' }>
export type ChunkNode = Extract<Node, { kind: 'chunk' }>
export type IntegerNode = Extract<Node, { kind: 'integer' }>
export type DecimalNode = Extract<Node, { kind: 'decimal' }>
export type RadixNode = Extract<Node, { kind: 'radix' }>

// what a group holds, and a name's and a text's parts
export type GroupChild = GroupNode | NameNode | TextNode | IntegerNode | DecimalNode | RadixNode
export type Part = ChunkNode | InterpolationNode

export function isGroup(node: Node | undefined): node is GroupNode {
  return node?.kind === 'group'
}

// the groups among `nodes`: every node of a root is one, and every group an interpolation holds
export function groupsOf(nodes: Node[]): GroupNode[] {
  return nodes.filter(isGroup)
}

// what a group holds: every node but a chunk and an interpolation, which only a name or a text holds
export function childrenOf(group: { nodes: Node[] }): GroupChild[] {
  return group.nodes.filter((node): node is GroupChild => node.kind !== 'chunk' && node.kind !== 'interpolation')
}

// a name's or a text's parts
export function partsOf(owner: { parts: Node[] }): Part[] {
  return owner.parts.filter((node): node is Part => node.kind === 'chunk' || node.kind === 'interpolation')
}

// the group an interpolation holds, when it holds one
export function groupOf(hole: InterpolationNode): GroupNode | undefined {
  return isGroup(hole.group) ? hole.group : undefined
}
