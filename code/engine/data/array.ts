// The array type, a persistent size-balanced TREE of values, not a flat buffer. Get / set / push / slice are
// O(log n) with structural sharing, and the tree is the shape the hyperbolic substrate wants (a subtree of the
// splitting tree, fan-out = the dock's direction count). Generic over the element type, so the engine uses
// Vector<Value>. Immutable: every op returns a new vector, which the imperative engine rebinds.

const MAX_LEAF = 32 // elements per leaf chunk
const REBALANCE_DEPTH = 40

export type Vector<T> =
  | { form: 'leaf'; items: T[]; size: number }
  | {
      form: 'branch'
      left: Vector<T>
      right: Vector<T>
      size: number
      depth: number
    }

export function empty<T>(): Vector<T> {
  return { form: 'leaf', items: [], size: 0 }
}

export function fromArray<T>(items: T[]): Vector<T> {
  if (items.length <= MAX_LEAF)
    return { form: 'leaf', items: items.slice(), size: items.length }
  const mid = items.length >> 1
  return branch(
    fromArray(items.slice(0, mid)),
    fromArray(items.slice(mid)),
  )
}

function depthOf<T>(v: Vector<T>): number {
  return v.form === 'leaf' ? 0 : v.depth
}

function branch<T>(left: Vector<T>, right: Vector<T>): Vector<T> {
  return {
    form: 'branch',
    left,
    right,
    size: left.size + right.size,
    depth: 1 + Math.max(depthOf(left), depthOf(right)),
  }
}

export function size<T>(v: Vector<T>): number {
  return v.size
}

export function get<T>(v: Vector<T>, index: number): T {
  if (index < 0 || index >= v.size)
    throw new Error(`index ${index} out of range (size ${v.size})`)
  let node = v
  let i = index
  while (node.form === 'branch') {
    if (i < node.left.size) node = node.left
    else {
      i -= node.left.size
      node = node.right
    }
  }
  return node.items[i]!
}

export function set<T>(
  v: Vector<T>,
  index: number,
  value: T,
): Vector<T> {
  if (index < 0 || index >= v.size)
    throw new Error(`index ${index} out of range (size ${v.size})`)
  if (v.form === 'leaf') {
    const items = v.items.slice()
    items[index] = value
    return { form: 'leaf', items, size: v.size }
  }
  if (index < v.left.size)
    return branch(set(v.left, index, value), v.right)
  return branch(v.left, set(v.right, index - v.left.size, value))
}

export function push<T>(v: Vector<T>, value: T): Vector<T> {
  if (v.form === 'leaf') {
    if (v.items.length < MAX_LEAF)
      return {
        form: 'leaf',
        items: [...v.items, value],
        size: v.size + 1,
      }
    return branch(v, { form: 'leaf', items: [value], size: 1 })
  }
  const grown = branch(v.left, push(v.right, value))
  return depthOf(grown) > REBALANCE_DEPTH
    ? fromArray(toArray(grown))
    : grown
}

// drop the last element, returning the shorter vector (the imperative pop, value read separately via get)
export function pop<T>(v: Vector<T>): Vector<T> {
  if (v.size === 0) throw new Error('pop on empty vector')
  return slice(v, 0, v.size - 1)
}

export function slice<T>(
  v: Vector<T>,
  start: number,
  end: number = v.size,
): Vector<T> {
  const s = Math.max(0, start)
  const e = Math.min(v.size, end)
  if (s >= e) return empty()
  if (v.form === 'leaf')
    return { form: 'leaf', items: v.items.slice(s, e), size: e - s }
  const leftLen = v.left.size
  if (e <= leftLen) return slice(v.left, s, e)
  if (s >= leftLen) return slice(v.right, s - leftLen, e - leftLen)
  return concat(
    slice(v.left, s, leftLen),
    slice(v.right, 0, e - leftLen),
  )
}

export function concat<T>(a: Vector<T>, b: Vector<T>): Vector<T> {
  if (a.size === 0) return b
  if (b.size === 0) return a
  const joined = branch(a, b)
  return depthOf(joined) > REBALANCE_DEPTH
    ? fromArray(toArray(joined))
    : joined
}

export function toArray<T>(v: Vector<T>): T[] {
  const out: T[] = []
  const walk = (node: Vector<T>): void => {
    if (node.form === 'leaf') {
      for (const x of node.items) out.push(x)
    } else {
      walk(node.left)
      walk(node.right)
    }
  }
  walk(v)
  return out
}

export function map<T, U>(
  v: Vector<T>,
  fn: (value: T, index: number) => U,
): Vector<U> {
  return fromArray(toArray(v).map(fn))
}

export function reduce<T, A>(
  v: Vector<T>,
  fn: (acc: A, value: T) => A,
  initial: A,
): A {
  let acc = initial
  const walk = (node: Vector<T>): void => {
    if (node.form === 'leaf') {
      for (const x of node.items) acc = fn(acc, x)
    } else {
      walk(node.left)
      walk(node.right)
    }
  }
  walk(v)
  return acc
}
