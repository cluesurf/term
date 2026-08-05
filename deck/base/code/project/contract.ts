// What a consumer depends on, and whether a commit still satisfies it.
//
// A projection whose mapping names a field that no longer arrives keeps serving happily
// with that column frozen in the past. Nothing reports it: the projection IS current, it
// is serving the newest commit, and the lag contract sees no lag. The column is simply
// stale forever.
//
// This makes that state unreachable. A consumer declares the properties it reads, the
// platform checks a candidate commit against that declaration, and the outcome is either
// FOLLOW or PIN. There is deliberately no third outcome, because the third outcome is the
// bug.
//
// See note/library/base/design/consumer-contracts.md.

import type { Dataset } from '@term/base/code/diff/change'
import type { Mapping } from '@term/base/code/project/mapping'

/** One property a consumer reads, at the granularity that decides its fate. */
export type Dependency = { form: string; property: string }

export type Contract = {
  // who this belongs to, so a pin can be reported to someone
  consumer: string
  reads: Array<Dependency>
}

/**
 * A contract from a projection's mapping.
 *
 * To have a projection at all, a consumer already declared which field lands in which
 * column. That declaration IS the contract, so nothing extra has to be collected from a
 * customer running their own database, and a derived contract cannot drift from what the
 * projector actually reads.
 */
export function contractOf(input: {
  consumer: string
  mapping: Mapping
}): Contract {
  const reads: Array<Dependency> = []

  for (const table of input.mapping.tables) {
    for (const column of table.columns) {
      reads.push({ form: table.form, property: column.field })
    }
  }

  return { consumer: input.consumer, reads }
}

// Why a property is still readable. `present` and `derivable` both mean the consumer
// follows; they are kept apart because a derivable read costs a conversion and is worth
// reporting.
export type Standing = 'present' | 'derivable' | 'gone'

export type Finding = Dependency & { standing: Standing }

export type Verdict =
  | { follow: true; consumer: string; derived: Array<Finding> }
  | { follow: false; consumer: string; gone: Array<Finding>; pin: string }

/**
 * How a property may still be reachable after a restructuring.
 *
 * `renames` covers a property that moved name within its form. `moved` covers one that
 * moved to another form still reachable by reference, which a join recovers. Anything not
 * described here and not present is gone, and no amount of effort recovers it.
 */
export type Derivation = {
  renames?: Array<{ form: string; from: string; to: string }>
  moved?: Array<{ form: string; property: string; toForm: string }>
}

function presentIn(dataset: Dataset, form: string, property: string): boolean {
  for (const record of dataset.values()) {
    if (record.type === form && record.fields.has(property)) {
      return true
    }
  }

  return false
}

function formPresent(dataset: Dataset, form: string): boolean {
  for (const record of dataset.values()) {
    if (record.type === form) {
      return true
    }
  }

  return false
}

/**
 * Check a contract against the state at a commit.
 *
 * A form with no records at all is NOT treated as gone. An empty form is
 * indistinguishable from a deleted one by inspection, and pinning every consumer of a
 * form that merely has no rows today would be wrong in the expensive direction. Only a
 * form that still has records, minus the property, counts as a loss.
 */
export function check(input: {
  contract: Contract
  dataset: Dataset
  derivation?: Derivation
  // the commit this dataset is from, reported as the pin point when a check fails
  at: string
}): Verdict {
  const derived: Array<Finding> = []
  const gone: Array<Finding> = []

  for (const read of input.contract.reads) {
    if (presentIn(input.dataset, read.form, read.property)) {
      continue
    }

    // the form itself carries no records here, so nothing can be concluded
    if (!formPresent(input.dataset, read.form)) {
      continue
    }

    const renamed = input.derivation?.renames?.find(
      r => r.form === read.form && r.from === read.property,
    )

    if (renamed && presentIn(input.dataset, read.form, renamed.to)) {
      derived.push({ ...read, standing: 'derivable' })
      continue
    }

    const moved = input.derivation?.moved?.find(
      m => m.form === read.form && m.property === read.property,
    )

    if (moved && presentIn(input.dataset, moved.toForm, read.property)) {
      derived.push({ ...read, standing: 'derivable' })
      continue
    }

    gone.push({ ...read, standing: 'gone' })
  }

  if (gone.length) {
    return { follow: false, consumer: input.contract.consumer, gone, pin: input.at }
  }

  return { follow: true, consumer: input.contract.consumer, derived }
}

/**
 * The blast radius of a candidate commit, before it lands.
 *
 * This is the thing a relational migration cannot answer. Given the registered contracts
 * and the state a change would produce, it returns exactly which consumers break and on
 * exactly which properties, so a restructuring can be sequenced rather than hoped over.
 */
export function impact(input: {
  contracts: Array<Contract>
  dataset: Dataset
  derivation?: Derivation
  at: string
}): { follow: Array<Verdict>; pinned: Array<Verdict> } {
  const follow: Array<Verdict> = []
  const pinned: Array<Verdict> = []

  for (const contract of input.contracts) {
    const verdict = check({
      contract,
      dataset: input.dataset,
      derivation: input.derivation,
      at: input.at,
    })

    if (verdict.follow) {
      follow.push(verdict)
    } else {
      pinned.push(verdict)
    }
  }

  return { follow, pinned }
}

/** Every consumer that reads a given property, so a deprecation is a lookup. */
export function readersOf(input: {
  contracts: Array<Contract>
  form: string
  property: string
}): Array<string> {
  return input.contracts
    .filter(contract =>
      contract.reads.some(
        read => read.form === input.form && read.property === input.property,
      ),
    )
    .map(contract => contract.consumer)
}
