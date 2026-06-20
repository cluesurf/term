// The memory model, lowered in the MIR: mutable value semantics realized by precise reference counting (Perceus)
// with functional-but-in-place reuse (FBIP). Values do not alias; the compiler inserts exact dup/drop operations
// from a static last-use analysis, and when a uniquely-owned allocation is freed right before an allocation of the
// same shape, it is reused in place instead of freed-and-reallocated. This ties to the kernel's linearity (a `1`
// multiplicity is a uniquely-owned value). See note/research/vibe/computation/plans/05-ir.md and design/readme.md.
// Browser-safe. This is the analysis on a straight-line MIR; lowering full control flow onto it is the next step.

export type Value =
  | { kind: 'make'; ctor: string; args: Array<string>; reuse?: string }
  | { kind: 'call'; fn: string; args: Array<string> }
  | { kind: 'var'; name: string }
  | { kind: 'lit' }

export type Inst =
  | { op: 'let'; name: string; value: Value }
  | { op: 'return'; name: string }
  | { op: 'dup'; name: string }
  | { op: 'drop'; name: string }
  | { op: 'if'; cond: string; then: Array<Inst>; else: Array<Inst> }

// the variables an instruction reads
function reads(inst: Inst): Array<string> {
  if (inst.op === 'return') return [inst.name]
  if (inst.op === 'let') {
    const v = inst.value
    if (v.kind === 'make' || v.kind === 'call') return v.args
    if (v.kind === 'var') return [v.name]
    return []
  }
  return []
}

// run Perceus over a straight-line function body. params are the owned inputs.
export function perceus(
  params: Array<string>,
  body: Array<Inst>,
): Array<Inst> {
  // last-use index of each variable (the point where its owned reference is consumed)
  const lastUse = new Map<string, number>()
  body.forEach((inst, i) => {
    for (const v of reads(inst)) lastUse.set(v, i)
  })

  // arity of each record binding, for reuse matching
  const arity = new Map<string, number>()
  for (const inst of body) {
    if (inst.op === 'let' && inst.value.kind === 'make')
      arity.set(inst.name, inst.value.args.length)
  }

  const out: Array<Inst> = []

  // a parameter never used must be dropped at entry (it was owned but consumed nowhere)
  for (const p of params)
    if (!lastUse.has(p)) out.push({ op: 'drop', name: p })

  body.forEach((inst, i) => {
    // a non-last use needs a dup: we are taking a reference while the value lives on for a later use
    for (const v of reads(inst)) {
      if (lastUse.get(v) !== i) out.push({ op: 'dup', name: v })
    }
    out.push(inst)
    // a binding that is never read is dead: drop it right after it is created
    if (inst.op === 'let' && !lastUse.has(inst.name))
      out.push({ op: 'drop', name: inst.name })
  })

  return reuse(out, arity)
}

// FBIP: a `drop x` of a record immediately followed by a `let y = make(...)` of the same arity reuses x's cell
function reuse(
  insts: Array<Inst>,
  arity: Map<string, number>,
): Array<Inst> {
  const out: Array<Inst> = []
  for (let i = 0; i < insts.length; i++) {
    const here = insts[i]!
    const next = insts[i + 1]
    if (
      here.op === 'drop' &&
      arity.has(here.name) &&
      next &&
      next.op === 'let' &&
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
  params: Array<string>,
  body: Array<Inst>,
): Array<Inst> {
  const [out, liveIn] = processBlock(body, new Set<string>())
  // an owned parameter never used on any path is dropped at entry
  const entryDrops: Array<Inst> = []
  for (const p of params)
    if (!liveIn.has(p)) entryDrops.push({ op: 'drop', name: p })
  return [...entryDrops, ...out]
}

// process a block backward. `liveAfter` is the set of variables that must remain owned when the block exits.
// Returns the rewritten block and the set live at entry.
function processBlock(
  insts: Array<Inst>,
  liveAfter: Set<string>,
): [Array<Inst>, Set<string>] {
  const live = new Set(liveAfter)
  const reversed: Array<Inst> = []
  for (let i = insts.length - 1; i >= 0; i--) {
    const inst = insts[i]!
    if (inst.op === 'if') {
      const [thenOut, thenIn] = processBlock(inst.then, live)
      const [elseOut, elseIn] = processBlock(inst.else, live)
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
      for (const v of thenIn) live.add(v)
      for (const v of elseIn) live.add(v)
      continue
    }
    const def = inst.op === 'let' ? inst.name : undefined
    const dups: Array<Inst> = []
    for (const v of reads(inst))
      if (live.has(v)) dups.push({ op: 'dup', name: v }) // used again later: take a reference
    if (def && inst.op === 'let' && !live.has(def))
      reversed.push({ op: 'drop', name: def }) // a dead binding
    reversed.push(inst)
    for (const d of dups) reversed.push(d)
    if (def) live.delete(def)
    for (const v of reads(inst)) live.add(v)
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
        return `let ${inst.name} = make ${v.ctor}(${v.args.join(
          ', ',
        )})${v.reuse ? ` reuse ${v.reuse}` : ''}`
      if (v.kind === 'call')
        return `let ${inst.name} = ${v.fn}(${v.args.join(', ')})`
      if (v.kind === 'var') return `let ${inst.name} = ${v.name}`
      return `let ${inst.name} = lit`
    }
    case 'if':
      return `if ${inst.cond} { ${inst.then
        .map(showInst)
        .join('; ')} } else { ${inst.else.map(showInst).join('; ')} }`
  }
}
