import type { RecordNode, Value } from '@/base/type'
import { canonicalizeValue } from '@/canon/canonicalize'
import type { Change } from '@/diff/change'
import { MemoryProjection } from '@/project/projection'
import { compareValues, fieldText } from '@/query/compare'
import { OrderedIndex } from '@/query/ordered-index'

// A native query surface over the record graph, plus declared indexes so equality,
// range, and prefix lookups do not scan every record. The query model is deliberately
// small: a type, a conjunction of field predicates, and ordering, evaluated over a
// projection. It is not SQL, but a SQL, Datalog, or GraphQL front end can compile to
// it. See note/library/base/design/query-and-indexing.md.

export type Comparator = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'prefix' | 'in'

export type Predicate =
  | { field: string; op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'; value: Value }
  | { field: string; op: 'prefix'; value: string }
  | { field: string; op: 'in'; values: Array<Value> }

function matchesPredicate(node: RecordNode, pred: Predicate): boolean {
  const v = node.fields.get(pred.field)
  if (v === undefined) {
    return false
  }
  switch (pred.op) {
    case 'eq':
      return canonicalizeValue(v) === canonicalizeValue(pred.value)
    case 'neq':
      return canonicalizeValue(v) !== canonicalizeValue(pred.value)
    case 'lt':
      return compareValues(v, pred.value) < 0
    case 'lte':
      return compareValues(v, pred.value) <= 0
    case 'gt':
      return compareValues(v, pred.value) > 0
    case 'gte':
      return compareValues(v, pred.value) >= 0
    case 'prefix': {
      const t = fieldText(v)
      return t !== undefined && t.startsWith(pred.value)
    }
    case 'in': {
      const cv = canonicalizeValue(v)
      return pred.values.some(x => canonicalizeValue(x) === cv)
    }
  }
}

export type Order = { field: string; dir: 'asc' | 'desc' }

// A fluent query. Chain predicates and ordering, then run against a projection.
export class Query {
  private preds: Array<Predicate> = []
  private ordering: Order | undefined
  private limitN: number | undefined
  private offsetN = 0

  constructor(public readonly type: string) {}

  eq(field: string, value: Value): this {
    this.preds.push({ field, op: 'eq', value })
    return this
  }
  neq(field: string, value: Value): this {
    this.preds.push({ field, op: 'neq', value })
    return this
  }
  lt(field: string, value: Value): this {
    this.preds.push({ field, op: 'lt', value })
    return this
  }
  lte(field: string, value: Value): this {
    this.preds.push({ field, op: 'lte', value })
    return this
  }
  gt(field: string, value: Value): this {
    this.preds.push({ field, op: 'gt', value })
    return this
  }
  gte(field: string, value: Value): this {
    this.preds.push({ field, op: 'gte', value })
    return this
  }
  prefix(field: string, value: string): this {
    this.preds.push({ field, op: 'prefix', value })
    return this
  }
  in(field: string, values: Array<Value>): this {
    this.preds.push({ field, op: 'in', values })
    return this
  }
  order(field: string, dir: 'asc' | 'desc' = 'asc'): this {
    this.ordering = { field, dir }
    return this
  }
  limit(n: number): this {
    this.limitN = n
    return this
  }
  offset(n: number): this {
    this.offsetN = n
    return this
  }

  predicates(): Array<Predicate> {
    return this.preds
  }

  orderBy(): Order | undefined {
    return this.ordering
  }

  // Run against a candidate set (already narrowed by type and any usable index).
  run(candidates: Array<RecordNode>): Array<RecordNode> {
    let out = candidates.filter(r => this.preds.every(p => matchesPredicate(r, p)))
    if (this.ordering !== undefined) {
      const ord = this.ordering
      out = [...out].sort((a, b) => {
        const av = a.fields.get(ord.field)
        const bv = b.fields.get(ord.field)
        if (av === undefined && bv === undefined) return 0
        if (av === undefined) return 1
        if (bv === undefined) return -1
        const c = compareValues(av, bv)
        return ord.dir === 'asc' ? c : -c
      })
    }
    if (this.offsetN > 0) {
      out = out.slice(this.offsetN)
    }
    if (this.limitN !== undefined) {
      out = out.slice(0, this.limitN)
    }
    return out
  }
}

export function query(type: string): Query {
  return new Query(type)
}

// An equality index over (type, field): canonical value -> marks. Maintained
// incrementally from the change feed so a declared index never drifts from the data.
type IndexKey = string

function indexKey(type: string, field: string): IndexKey {
  return `${type}\t${field}`
}

// A projection that maintains declared indexes and evaluates Query objects, using an
// equality index for a leading `eq` predicate and an ordered index for a range, prefix,
// or ordered read, falling back to a type scan when neither applies.
export class QueryableProjection extends MemoryProjection {
  private indexes = new Map<IndexKey, Map<string, Set<string>>>()
  private ordered = new Map<IndexKey, OrderedIndex>()
  private declared: Array<{ type: string; field: string }> = []
  private declaredOrdered: Array<{ type: string; field: string }> = []

  // Declare an equality index. Rebuilds it from current data so it is correct
  // whether declared before or after loading.
  declareIndex(type: string, field: string): void {
    const key = indexKey(type, field)
    this.declared.push({ type, field })
    const idx = new Map<string, Set<string>>()
    for (const node of this.byType(type)) {
      const v = node.fields.get(field)
      if (v !== undefined && node.mark !== undefined) {
        addTo(idx, canonicalizeValue(v), node.mark)
      }
    }
    this.indexes.set(key, idx)
  }

  // Declare an ordered index, for range, prefix, and ordered queries. Rebuilds from
  // current data like the equality index.
  declareOrderedIndex(type: string, field: string): void {
    const key = indexKey(type, field)
    this.declaredOrdered.push({ type, field })
    const idx = new OrderedIndex()
    for (const node of this.byType(type)) {
      const v = node.fields.get(field)
      if (v !== undefined && node.mark !== undefined) {
        idx.set(node.mark, v)
      }
    }
    this.ordered.set(key, idx)
  }

  apply(changes: Array<Change>): void {
    // Snapshot the pre-state of every touched, indexed field (equality or ordered) so
    // the indexes move precisely rather than rebuilding.
    const declaredAll = [...this.declared, ...this.declaredOrdered]
    const before = new Map<string, Value | undefined>()
    for (const ch of changes) {
      const mark = ch.mark
      const node = this.get(mark)
      for (const { type, field } of declaredAll) {
        if (node !== undefined && node.type === type) {
          before.set(snapKey(mark, field), node.fields.get(field))
        }
      }
    }
    super.apply(changes)
    for (const ch of changes) {
      const mark = ch.mark
      const node = this.get(mark)
      for (const { type, field } of this.declared) {
        const idx = this.indexes.get(indexKey(type, field))!
        const prev = before.get(snapKey(mark, field))
        if (prev !== undefined) {
          removeFrom(idx, canonicalizeValue(prev), mark)
        }
        const now =
          node !== undefined && node.type === type ? node.fields.get(field) : undefined
        if (now !== undefined) {
          addTo(idx, canonicalizeValue(now), mark)
        }
      }
      for (const { type, field } of this.declaredOrdered) {
        const idx = this.ordered.get(indexKey(type, field))!
        const now =
          node !== undefined && node.type === type ? node.fields.get(field) : undefined
        if (now === undefined) {
          idx.remove(mark)
        } else {
          idx.set(mark, now)
        }
      }
    }
  }

  hasIndex(type: string, field: string): boolean {
    return this.indexes.has(indexKey(type, field))
  }

  hasOrderedIndex(type: string, field: string): boolean {
    return this.ordered.has(indexKey(type, field))
  }

  // Marks matching an indexed equality, or undefined if there is no such index.
  lookup(type: string, field: string, value: Value): Array<string> | undefined {
    const idx = this.indexes.get(indexKey(type, field))
    if (idx === undefined) {
      return undefined
    }
    const set = idx.get(canonicalizeValue(value))
    return set === undefined ? [] : [...set]
  }

  // The marks an ordered predicate selects via the ordered index, or undefined if the
  // field has no ordered index or the predicate is not a range or prefix.
  private orderedCandidates(type: string, pred: Predicate): Array<string> | undefined {
    const idx = this.ordered.get(indexKey(type, pred.field))
    if (idx === undefined) {
      return undefined
    }
    switch (pred.op) {
      case 'lt':
        return idx.range(undefined, false, pred.value, false)
      case 'lte':
        return idx.range(undefined, false, pred.value, true)
      case 'gt':
        return idx.range(pred.value, false, undefined, false)
      case 'gte':
        return idx.range(pred.value, true, undefined, false)
      case 'prefix':
        return idx.prefix(pred.value)
      default:
        return undefined
    }
  }

  // Evaluate a query. It narrows candidates through, in order of preference: a leading
  // equality index, then an ordered index for a range or prefix predicate, else a type
  // scan. Remaining predicates and ordering are applied over the candidates.
  find(q: Query): Array<RecordNode> {
    let marks: Array<string> | undefined
    for (const p of q.predicates()) {
      if (p.op === 'eq' && this.hasIndex(q.type, p.field)) {
        marks = this.lookup(q.type, p.field, p.value)!
        break
      }
    }
    if (marks === undefined) {
      for (const p of q.predicates()) {
        const got = this.orderedCandidates(q.type, p)
        if (got !== undefined) {
          marks = got
          break
        }
      }
    }
    const candidates =
      marks !== undefined
        ? marks.map(m => this.get(m)).filter((r): r is RecordNode => r !== undefined)
        : this.byType(q.type)
    return q.run(candidates)
  }
}

function snapKey(mark: string, field: string): string {
  return `${mark}\t${field}`
}

function addTo(idx: Map<string, Set<string>>, key: string, mark: string): void {
  let set = idx.get(key)
  if (set === undefined) {
    set = new Set()
    idx.set(key, set)
  }
  set.add(mark)
}

function removeFrom(idx: Map<string, Set<string>>, key: string, mark: string): void {
  const set = idx.get(key)
  if (set !== undefined) {
    set.delete(mark)
    if (set.size === 0) {
      idx.delete(key)
    }
  }
}
