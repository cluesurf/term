import type { Mark, RecordNode } from '@/base/type'
import type { Dataset } from '@/diff/change'
import { ref } from '@/base/make'
import { compareHlc, type Hlc } from '@/merge/clock'

// Move-aware hierarchy. Records form a forest through a `~parent` reference, and moving a
// record changes that reference while keeping the record's mark, so a move preserves
// identity instead of being a delete-and-recreate (which is where git loses track of a
// moved thing). Two properties make this a proper tree CRDT rather than a plain field:
// a node has exactly one parent (it is one reference), and concurrent moves are merged
// so the forest never gains a cycle. The cycle-safe merge is Kleppmann's move algorithm:
// apply moves in timestamp order, and skip any move that would put a node under its own
// descendant.
//
// See note/library/base/design/identity-lifecycle.md.

const PARENT = '~parent'

export function parentOf(node: RecordNode): Mark | undefined {
  const v = node.fields.get(PARENT)
  return v !== undefined && v.kind === 'ref' ? v.target : undefined
}

// Move a record under a new parent (or to a root with `undefined`), keeping its mark.
export function moveRecord(
  dataset: Dataset,
  mark: Mark,
  parent: Mark | undefined,
): Dataset {
  const node = dataset.get(mark)
  if (node === undefined) {
    return dataset
  }
  const fields = new Map(node.fields)
  if (parent === undefined) {
    fields.delete(PARENT)
  } else {
    fields.set(PARENT, ref(parent))
  }
  const out: Dataset = new Map(dataset)
  out.set(mark, { ...node, fields })
  return out
}

export function childrenOf(dataset: Dataset, mark: Mark): Array<Mark> {
  const out: Array<Mark> = []
  for (const [m, node] of dataset) {
    if (parentOf(node) === mark) {
      out.push(m)
    }
  }
  return out.sort()
}

// Whether `ancestor` is on the parent chain of `mark` (or equal to it), in a parent map.
function isDescendantOf(
  parentMap: Map<Mark, Mark | undefined>,
  mark: Mark,
  ancestor: Mark,
): boolean {
  let cur: Mark | undefined = mark
  const seen = new Set<Mark>()
  while (cur !== undefined) {
    if (cur === ancestor) {
      return true
    }
    if (seen.has(cur)) {
      return false // an existing cycle: stop
    }
    seen.add(cur)
    cur = parentMap.get(cur)
  }
  return false
}

// --- move-aware diff ---------------------------------------------------------

export type MoveChange = { mark: Mark; from: Mark | undefined; to: Mark | undefined }

// The records whose parent changed between two states: reported as moves (identity
// preserved), not as removals and additions.
export function diffMoves(before: Dataset, after: Dataset): Array<MoveChange> {
  const out: Array<MoveChange> = []
  for (const [mark, node] of after) {
    const old = before.get(mark)
    if (old === undefined) {
      continue // a new record, not a move
    }
    const from = parentOf(old)
    const to = parentOf(node)
    if (from !== to) {
      out.push({ mark, from, to })
    }
  }
  return out
}

// --- op-based move CRDT (Kleppmann) ------------------------------------------

export type TreeMove = {
  mark: Mark
  parent: Mark | undefined
  time: Hlc
  // actor id, to break ties between moves with equal timestamps
  actor: string
}

// Apply a set of moves to a base dataset in timestamp order, skipping any move that
// would create a cycle. The result is a single-parent, cycle-free forest, independent of
// the order the moves arrived, which is what makes concurrent tree editing converge.
export function applyMoves(base: Dataset, moves: Array<TreeMove>): Dataset {
  const parentMap = new Map<Mark, Mark | undefined>()
  for (const [mark, node] of base) {
    parentMap.set(mark, parentOf(node))
  }
  const ordered = [...moves].sort((a, b) => {
    const c = compareHlc(a.time, b.time)
    if (c !== 0) {
      return c
    }
    return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0
  })

  let out = base
  for (const move of ordered) {
    if (!parentMap.has(move.mark)) {
      continue // moving an unknown record
    }
    // skip a move that would put the node under its own descendant (a cycle)
    if (
      move.parent !== undefined &&
      isDescendantOf(parentMap, move.parent, move.mark)
    ) {
      continue
    }
    parentMap.set(move.mark, move.parent)
    out = moveRecord(out, move.mark, move.parent)
  }
  return out
}

// --- state-based tree merge --------------------------------------------------

// Resolve concurrent parent assignments across a three-way merge into a single-parent,
// cycle-free forest. Per node the parent is: the agreed value if both sides agree, the
// side that changed if only one did, and otherwise a deterministic winner (the larger
// parent mark), so the result is independent of which side is called ours or theirs. Any
// cycle the winners would form is then broken deterministically by detaching the node
// with the smaller mark to a root.
export function mergeTree(base: Dataset, ours: Dataset, theirs: Dataset): Dataset {
  const marks = new Set<Mark>([...ours.keys(), ...theirs.keys()])
  const parentMap = new Map<Mark, Mark | undefined>()

  for (const mark of marks) {
    const b = base.get(mark)
    const o = ours.get(mark)
    const t = theirs.get(mark)
    const pb = b ? parentOf(b) : undefined
    const po = o ? parentOf(o) : undefined
    const pt = t ? parentOf(t) : undefined
    let winner: Mark | undefined
    if (o === undefined) {
      winner = pt
    } else if (t === undefined) {
      winner = po
    } else if (po === pt) {
      winner = po
    } else if (po === pb) {
      winner = pt // only theirs moved
    } else if (pt === pb) {
      winner = po // only ours moved
    } else {
      // both moved differently: deterministic tiebreak by parent mark
      winner = (po ?? '') >= (pt ?? '') ? po : pt
    }
    parentMap.set(mark, winner)
  }

  // break any cycles deterministically: detach the smaller mark in each cycle to a root
  breakCycles(parentMap)

  // materialize onto the merged records
  let out: Dataset = new Map()
  for (const mark of marks) {
    const node = ours.get(mark) ?? theirs.get(mark)!
    out.set(mark, node)
  }
  for (const [mark, parent] of parentMap) {
    out = moveRecord(out, mark, parent)
  }
  return out
}

// Reparent any record whose parent is absent from the dataset (its parent was deleted,
// possibly concurrently with a move into it) to a recovery root, so the record is not
// silently orphaned. With no recovery root given it is detached to a forest root.
export function recoverOrphans(
  dataset: Dataset,
  recoveryRoot?: Mark,
): { dataset: Dataset; recovered: Array<Mark> } {
  const recovered: Array<Mark> = []
  let out = dataset
  for (const [mark, node] of dataset) {
    const parent = parentOf(node)
    if (parent !== undefined && !dataset.has(parent)) {
      out = moveRecord(out, mark, recoveryRoot)
      recovered.push(mark)
    }
  }
  return { dataset: out, recovered }
}

function breakCycles(parentMap: Map<Mark, Mark | undefined>): void {
  for (const start of parentMap.keys()) {
    const path: Array<Mark> = []
    const onPath = new Set<Mark>()
    let cur: Mark | undefined = start
    while (cur !== undefined) {
      if (onPath.has(cur)) {
        // found a cycle: detach the smallest mark on it to a root
        const cycle = path.slice(path.indexOf(cur))
        const detach = [...cycle].sort()[0]!
        parentMap.set(detach, undefined)
        break
      }
      if (!parentMap.has(cur)) {
        break
      }
      onPath.add(cur)
      path.push(cur)
      cur = parentMap.get(cur)
    }
  }
}
