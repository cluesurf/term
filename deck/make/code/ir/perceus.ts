// The memory model, lowered in the MIR: mutable value semantics realized by precise reference counting (Perceus)
// with functional-but-in-place reuse (FBIP). Values do not alias; the compiler inserts exact dup/drop operations
// from a static last-use analysis, and when a uniquely-owned allocation is freed right before an allocation of the
// same shape, it is reused in place instead of freed-and-reallocated. This ties to the kernel's linearity (a `1`
// multiplicity is a uniquely-owned value). See note/research/vibe/computation/plans/05-ir.md and design/readme.md.
// Browser-safe. This is the analysis on a straight-line MIR; lowering full control flow onto it is the next step.

export type Value =
  | { kind: 'make'; ctor: string; args: string[]; reuse?: string }
  | { kind: 'call'; fn: string; args: string[] }
  | { kind: 'var'; name: string }
  | { kind: 'lit' }

export type Inst =
  | { op: 'let'; name: string; value: Value }
  | { op: 'return'; name: string }
  | { op: 'dup'; name: string }
  | { op: 'drop'; name: string }
  | { op: 'if'; cond: string; then: Inst[]; else: Inst[] }
  // a loop: the condition is a copyable boolean (no RC). A value owned at the header and used in the body is dup'd
  // per iteration (it must survive the back-edge to the next iteration) and dropped after the loop if dead there.
  | { op: 'while'; cond: string; body: Inst[] }
  // an N-way match (the subject is a copyable selector here; ADT field ownership is handled by the IR->MIR lowering).
  // Generalizes `if`: a value consumed in some arms but not others is dropped in the arms that do not consume it, so
  // every arm leaves the same ownership state (balanced).
  | { op: 'match'; subject: string; arms: Inst[][] }

// the variables an instruction reads
function reads(inst: Inst): string[] {
  if (inst.op === 'return') {return [inst.name]}

  if (inst.op === 'let') {
    const v = inst.value

    if (v.kind === 'make' || v.kind === 'call') {return v.args}

    if (v.kind === 'var') {return [v.name]}

    return []
  }

  return []
}

// run Perceus over a straight-line function body. params are the owned inputs.
export function perceus(
  params: string[],
  body: Inst[],
): Inst[] {
  // last-use index of each variable (the point where its owned reference is consumed)
  const lastUse = new Map<string, number>()
  body.forEach((inst, i) => {
    for (const v of reads(inst)) {lastUse.set(v, i)}
  })

  // arity of each record binding, for reuse matching
  const arity = new Map<string, number>()

  for (const inst of body) {
    if (inst.op === 'let' && inst.value.kind === 'make')
      {arity.set(inst.name, inst.value.args.length)}
  }

  const out: Inst[] = []

  // a parameter never used must be dropped at entry (it was owned but consumed nowhere)
  for (const p of params)
    {if (!lastUse.has(p)) {out.push({ op: 'drop', name: p })}}

  body.forEach((inst, i) => {
    // a non-last use needs a dup: we are taking a reference while the value lives on for a later use
    for (const v of reads(inst)) {
      if (lastUse.get(v) !== i) {out.push({ op: 'dup', name: v })}
    }

    out.push(inst)

    // a binding that is never read is dead: drop it right after it is created
    if (inst.op === 'let' && !lastUse.has(inst.name))
      {out.push({ op: 'drop', name: inst.name })}
  })

  return reuse(out, arity)
}

// FBIP: a `drop x` of a record immediately followed by a `let y = make(...)` of the same arity reuses x's cell
function reuse(
  insts: Inst[],
  arity: Map<string, number>,
): Inst[] {
  const out: Inst[] = []

  for (let i = 0; i < insts.length; i++) {
    const here = insts[i]!
    const next = insts[i + 1]

    if (
      here.op === 'drop' &&
      arity.has(here.name) &&
      next?.op === 'let' &&
      next.value.kind === 'make' &&
      next.value.args.length === arity.get(here.name)
    ) {
      // reuse the dropped cell for the new construction; the drop is subsumed by the reuse
      out.push({
        op: 'let',
        name: next.name,
        value: { ...next.value, reuse: here.name },
      })
      i++ // skip the consumed `let`
    } else {
      out.push(here)
    }
  }

  return out
}

// Perceus over control flow: a backward liveness pass that inserts dup/drop through `if` branches with
// balanced ownership. A value owned at the branch is consumed on every path: if one branch uses it (consuming at
// last use) and the other does not, a `drop` is inserted in the other branch so neither leaks nor double-frees.
// This generalizes the straight-line `perceus` to the CFG. Booleans / conditions are treated as copyable (no RC).
export function perceusControl(
  params: string[],
  body: Inst[],
  // the reference-counted names. Only these get dup / drop; copyable values (integers, booleans) carry no RC, so
  // dup'ing one would call the runtime on a non-pointer. If omitted, every name is treated as heap (back-compat with
  // the MIR-only unit tests, which model all bindings as owned).
  heap?: Set<string>,
): Inst[] {
  const isHeap = (name: string): boolean => !heap || heap.has(name)
  const [out, liveIn] = processBlock(body, new Set<string>(), isHeap)
  // an owned parameter never used on any path is dropped at entry
  const entryDrops: Inst[] = []

  for (const p of params)
    {if (isHeap(p) && !liveIn.has(p))
      {entryDrops.push({ op: 'drop', name: p })}}

  return [...entryDrops, ...out]
}

// process a block backward. `liveAfter` is the set of (heap) variables that must remain owned when the block exits.
// `isHeap` selects the reference-counted names; copyable values are never dup'd / dropped. Returns the rewritten
// block and the set live at entry.
function processBlock(
  insts: Inst[],
  liveAfter: Set<string>,
  isHeap: (name: string) => boolean = () => true,
): [Inst[], Set<string>] {
  const live = new Set(liveAfter)
  const reversed: Inst[] = []

  for (let i = insts.length - 1; i >= 0; i--) {
    const inst = insts[i]!

    if (inst.op === 'while') {
      // Backward liveness over a loop needs a fixpoint: the body exits to BOTH the post-loop (the current `live`) and
      // back to the header (so the body's own live-in feeds its live-out). Iterate `liveHeader` until stable. Liveness
      // is monotone (only grows), so this converges.
      let liveHeader = new Set(live)

      for (;;) {
        const [, bodyIn] = processBlock(
          inst.body,
          new Set([...liveHeader, ...live]),
          isHeap,
        )
        const grown = new Set([...liveHeader, ...bodyIn])

        if (
          grown.size === liveHeader.size &&
          [...grown].every(v => liveHeader.has(v))
        )
          {break}

        liveHeader = grown
      }

      // final pass with the converged header-live set: a value in `liveHeader` that is read in the body is live across
      // the back-edge, so it is dup'd at each use (the per-iteration reference). A body-local binding that dies in the
      // body is dropped there, exactly as in straight-line code.
      const [bodyOut] = processBlock(
        inst.body,
        new Set([...liveHeader, ...live]),
      )

      // a value owned through the loop but dead after it (live at the header, not live after) keeps its original
      // owned reference past the last iteration; that reference must be dropped right after the loop.
      const dropsAfter = [...liveHeader].filter(v => !live.has(v))

      for (const v of dropsAfter) {reversed.push({ op: 'drop', name: v })}

      reversed.push({ op: 'while', cond: inst.cond, body: bodyOut })

      for (const v of liveHeader) {live.add(v)}

      continue
    }

    if (inst.op === 'match') {
      const armResults = inst.arms.map(arm =>
        processBlock(arm, live, isHeap),
      )
      const armIns = armResults.map(([, inSet]) => inSet)

      // the union of values consumed across all arms: every arm must leave the same set owned, so an arm that does
      // not consume one of these (and where it is not live after the match) drops it.
      const consumed = new Set<string>()

      for (const s of armIns) {for (const v of s) {consumed.add(v)}}

      const arms = armResults.map(([out], i) => {
        const drops = [...consumed]
          .filter(v => !armIns[i]!.has(v) && !live.has(v))
          .map((v): Inst => ({ op: 'drop', name: v }))

        return [...drops, ...out]
      })

      reversed.push({ op: 'match', subject: inst.subject, arms })

      for (const s of armIns) {for (const v of s) {live.add(v)}}

      continue
    }

    if (inst.op === 'if') {
      const [thenOut, thenIn] = processBlock(inst.then, live, isHeap)
      const [elseOut, elseIn] = processBlock(inst.else, live, isHeap)
      // a variable owned at the if but consumed in only one branch must be dropped in the other
      const dropInElse = [...thenIn]
        .filter(v => !elseIn.has(v) && !live.has(v))
        .map((v): Inst => ({ op: 'drop', name: v }))

      const dropInThen = [...elseIn]
        .filter(v => !thenIn.has(v) && !live.has(v))
        .map((v): Inst => ({ op: 'drop', name: v }))

      reversed.push({
        op: 'if',
        cond: inst.cond,
        then: [...dropInThen, ...thenOut],
        else: [...dropInElse, ...elseOut],
      })

      for (const v of thenIn) {live.add(v)}

      for (const v of elseIn) {live.add(v)}

      continue
    }

    const def = inst.op === 'let' ? inst.name : undefined

    // count heap reads: a value read k times in ONE instruction needs k references (a call that takes the value twice
    // consumes two). Only reference-counted (heap) reads matter; a copyable value (integer, boolean) carries no RC.
    const readCounts = new Map<string, number>()

    for (const v of reads(inst))
      {if (isHeap(v)) {readCounts.set(v, (readCounts.get(v) ?? 0) + 1)}}

    const dups: Inst[] = []

    for (const [v, count] of readCounts) {
      // references needed here = `count` consumed + (1 to survive if the value is live after); the original supplies
      // one, so the remainder are dup'd.
      const need = count + (live.has(v) ? 1 : 0) - 1

      for (let k = 0; k < need; k++) {dups.push({ op: 'dup', name: v })}
    }

    if (def && inst.op === 'let' && isHeap(def) && !live.has(def))
      {reversed.push({ op: 'drop', name: def })} // a dead heap binding

    reversed.push(inst)

    for (const d of dups) {reversed.push(d)}

    if (def) {live.delete(def)}

    // `live` tracks only heap names (copyable values need no liveness for RC)
    for (const v of readCounts.keys()) {live.add(v)}
  }

  return [reversed.reverse(), live]
}

export function showInst(inst: Inst): string {
  switch (inst.op) {
    case 'dup':
      return `dup ${inst.name}`
    case 'drop':
      return `drop ${inst.name}`
    case 'return':
      return `return ${inst.name}`

    case 'let': {
      const v = inst.value

      if (v.kind === 'make')
        {return `let ${inst.name} = make ${v.ctor}(${v.args.join(
          ', ',
        )})${v.reuse ? ` reuse ${v.reuse}` : ''}`}

      if (v.kind === 'call')
        {return `let ${inst.name} = ${v.fn}(${v.args.join(', ')})`}

      if (v.kind === 'var') {return `let ${inst.name} = ${v.name}`}

      return `let ${inst.name} = lit`
    }

    case 'if':
      return `if ${inst.cond} { ${inst.then
        .map(showInst)
        .join('; ')} } else { ${inst.else.map(showInst).join('; ')} }`

    case 'while':
      return `while ${inst.cond} { ${inst.body
        .map(showInst)
        .join('; ')} }`

    case 'match':
      return `match ${inst.subject} { ${inst.arms
        .map(arm => arm.map(showInst).join('; '))
        .join(' | ')} }`
  }
}
