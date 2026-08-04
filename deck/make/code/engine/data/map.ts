// The map type, a TERNARY TRIE (radix tree): three-way branching per trit of the key. A key (a string) is encoded
// to a balanced-ternary digit sequence (each codepoint a fixed 14 trits, 3^14 > the full Unicode range, so no
// boundary collisions), and the trie branches -1 / 0 / +1 at each trit. Lookup and insert are O(key trits), and
// the trie is laid on the splitting tree (a key's path IS its address). Mutable, as an imperative map should be.
// Generic over the value type, so the engine uses TernaryMap<Value>; keys are canonicalised to strings by it.

import {
  toTrits,
  type Trit,
} from '@term/make/code/engine/data/trit'

const TRITS_PER_CODEPOINT = 14 // 3^14 = 4,782,969 > 0x10FFFF (max Unicode scalar)

type TrieNode<V> = {
  entry?: { key: string; value: V }
  kids: (TrieNode<V> | undefined)[] // kids[trit + 1], so index 0 / 1 / 2 for trit -1 / 0 / +1
}

export type TernaryMap<V> = {
  root: TrieNode<V>
  size: number
}

export function makeMap<V>(): TernaryMap<V> {
  return { root: { kids: [] }, size: 0 }
}

// the balanced-ternary digits of a key, each codepoint padded to a fixed width so keys cannot alias
function keyTrits(key: string): Trit[] {
  const out: Trit[] = []

  for (const ch of key) {
    const trits = toTrits(BigInt(ch.codePointAt(0)!))

    for (let i = 0; i < TRITS_PER_CODEPOINT; i++) {
      out.push(trits[i] ?? 0)
    }
  }

  return out
}

function descend<V>(
  root: TrieNode<V>,
  trits: Trit[],
  create: boolean,
): TrieNode<V> | undefined {
  let node = root

  for (const t of trits) {
    const slot = t + 1

    let next = node.kids[slot]

    if (!next) {
      if (!create) {
        return undefined
      }

      next = { kids: [] }
      node.kids[slot] = next
    }

    node = next
  }

  return node
}

export function set<V>(
  map: TernaryMap<V>,
  key: string,
  value: V,
): void {
  const node = descend(map.root, keyTrits(key), true)!

  if (!node.entry) {
    map.size += 1
  }

  node.entry = { key, value }
}

export function get<V>(map: TernaryMap<V>, key: string): V | undefined {
  return descend(map.root, keyTrits(key), false)?.entry?.value
}

export function has<V>(map: TernaryMap<V>, key: string): boolean {
  return descend(map.root, keyTrits(key), false)?.entry !== undefined
}

export function remove<V>(map: TernaryMap<V>, key: string): boolean {
  const node = descend(map.root, keyTrits(key), false)

  if (!node?.entry) {
    return false
  }

  node.entry = undefined
  map.size -= 1

  return true
}

export function size<V>(map: TernaryMap<V>): number {
  return map.size
}

// every stored entry, in trit order (a stable, content-sorted traversal)
export function entries<V>(
  map: TernaryMap<V>,
): { key: string; value: V }[] {
  const out: { key: string; value: V }[] = []

  const walk = (node: TrieNode<V>): void => {
    if (node.entry) {
      out.push(node.entry)
    }

    for (const kid of node.kids) {
      if (kid) {
        walk(kid)
      }
    }
  }

  walk(map.root)

  return out
}

export function keys<V>(map: TernaryMap<V>): string[] {
  return entries(map).map(e => e.key)
}

export function values<V>(map: TernaryMap<V>): V[] {
  return entries(map).map(e => e.value)
}
