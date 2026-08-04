// The projector: keeping a relational store in step with a repository.
//
// A projection is a REBUILDABLE CACHE, never a source of truth. Every property here
// follows from that: applying a commit is idempotent, the serving commit travels with
// every read, and a projection can always be rebuilt from empty. The last is what makes
// every other choice reversible, since a wrong engine, a wrong layout, or a corrupted
// projection is a rebuild rather than a repair.
//
// See note/library/base/design/projection-schema.md and
// note/library/base/plan/implementation.md phase 4.

import type { Change, Dataset } from '@term/base/code/diff/change'
import { BOOKKEEPING_TABLE, createBookkeeping, createTable, quote } from '@term/base/code/project/ddl'
import type { Dialect } from '@term/base/code/project/ddl'
import type { Mapping } from '@term/base/code/project/mapping'
import { rowOf, tableFor } from '@term/base/code/project/mapping'
import type { Statement } from '@term/base/code/project/sql'
import { toStatement } from '@term/base/code/project/sql'
import type { TableForm } from '@term/base/code/project/table'
import { mergeWrites, writesFor } from '@term/base/code/project/write'

// The seam an engine implements. Deliberately small: everything above it is dialect-free,
// so a second engine is an adapter rather than a second projector.
export type Transaction = {
  run(statement: Statement): Promise<void>
  all(statement: Statement): Promise<Array<Record<string, unknown>>>
}

export type Engine = {
  dialect: Dialect
  transact<T>(body: (tx: Transaction) => Promise<T>): Promise<T>
}

export type ProjectionState = {
  repository: string
  commit: string | undefined
}

/**
 * A projection of one repository into one engine.
 *
 * One projector, one engine, one shared instance. A repository with several projections
 * has several of these, which is what keeps a search target or a columnar target from
 * complicating the relational one.
 */
export class Projector {
  constructor(
    private readonly engine: Engine,
    private readonly repository: string,
    private readonly mapping: Mapping,
  ) {}

  /** Create the tables an author declared, plus the projector's own bookkeeping. */
  async install(forms: Array<TableForm>): Promise<void> {
    await this.engine.transact(async tx => {
      for (const sql of createBookkeeping(this.engine.dialect)) {
        await tx.run({ sql, params: [] })
      }

      for (const form of forms) {
        for (const sql of createTable({ form, dialect: this.engine.dialect })) {
          await tx.run({ sql, params: [] })
        }
      }
    })
  }

  /**
   * The commit this projection currently serves.
   *
   * Every read exposes it, because a projection lags its repository by design and a
   * caller that cannot see the lag cannot reason about what it read.
   */
  async serving(): Promise<string | undefined> {
    const rows = await this.engine.transact(tx =>
      tx.all({
        sql: `SELECT "commit" FROM ${quote(BOOKKEEPING_TABLE)} WHERE "repository" = $1`,
        params: [this.repository],
      }),
    )

    const commit = rows[0]?.commit

    return typeof commit === 'string' ? commit : undefined
  }

  /** Whether a given commit has already been applied. */
  async hasApplied(commit: string): Promise<boolean> {
    const rows = await this.engine.transact(tx =>
      tx.all({
        sql: `SELECT "commit" FROM ${quote(`${BOOKKEEPING_TABLE}_log`)} WHERE "repository" = $1 AND "commit" = $2`,
        params: [this.repository, commit],
      }),
    )

    return rows.length > 0
  }

  /**
   * Apply one commit's field-level changes, in one transaction.
   *
   * Idempotent, keyed by commit hash: a commit already recorded is skipped entirely. This
   * is what makes a retry after a network failure safe, and it is why the bookkeeping
   * write shares the transaction with the row writes. If they could commit separately, a
   * crash between them would leave a projection that either loses a commit or replays one.
   */
  async apply(input: {
    commit: string
    changes: Array<Change>
  }): Promise<{ applied: boolean; writes: number }> {
    if (await this.hasApplied(input.commit)) {
      return { applied: false, writes: 0 }
    }

    const writes = mergeWrites(
      writesFor({ mapping: this.mapping, changes: input.changes }),
    )

    await this.engine.transact(async tx => {
      for (const write of writes) {
        await tx.run(toStatement(write))
      }

      await this.record(tx, input.commit)
    })

    return { applied: true, writes: writes.length }
  }

  /** Apply a run of commits in order, stopping at the first that fails. */
  async applyAll(
    commits: Array<{ commit: string; changes: Array<Change> }>,
  ): Promise<number> {
    let applied = 0

    for (const entry of commits) {
      const result = await this.apply(entry)

      if (result.applied) {
        applied += 1
      }
    }

    return applied
  }

  /**
   * Rebuild the projection from empty at a given commit.
   *
   * Takes the repository's full dataset rather than replaying history, because the result
   * must depend only on the state at that commit. Replaying would make a rebuild depend
   * on the path taken to reach it, and the point of a rebuild is that it does not.
   *
   * Deterministic: the same dataset and mapping produce the same rows, so two rebuilds of
   * the same commit are indistinguishable.
   */
  async rebuild(input: {
    commit: string
    dataset: Dataset
  }): Promise<{ writes: number }> {
    const changes: Array<Change> = []

    // sorted by mark, so the write order is a property of the data rather than of Map
    // insertion order
    const marks = [...input.dataset.keys()].sort()

    for (const mark of marks) {
      const record = input.dataset.get(mark)!

      if (tableFor(this.mapping, record.type)) {
        changes.push({ type: 'record.add', mark, value: record })
      }
    }

    const writes = writesFor({ mapping: this.mapping, changes })

    await this.engine.transact(async tx => {
      for (const table of this.mapping.tables) {
        await tx.run({ sql: `DELETE FROM ${quote(table.table)}`, params: [] })
      }

      await tx.run({
        sql: `DELETE FROM ${quote(`${BOOKKEEPING_TABLE}_log`)} WHERE "repository" = $1`,
        params: [this.repository],
      })

      for (const write of writes) {
        await tx.run(toStatement(write))
      }

      await this.record(tx, input.commit)
    })

    return { writes: writes.length }
  }

  /** Record a commit as applied, and advance the serving commit, in the caller's transaction. */
  private async record(tx: Transaction, commit: string): Promise<void> {
    await tx.run({
      sql: `INSERT INTO ${quote(`${BOOKKEEPING_TABLE}_log`)} ("repository", "commit") VALUES ($1, $2) ON CONFLICT ("repository", "commit") DO NOTHING`,
      params: [this.repository, commit],
    })

    await tx.run({
      sql: `INSERT INTO ${quote(BOOKKEEPING_TABLE)} ("repository", "commit") VALUES ($1, $2) ON CONFLICT ("repository") DO UPDATE SET "commit" = EXCLUDED."commit"`,
      params: [this.repository, commit],
    })
  }
}

/** The rows a mapping would write for a whole dataset, without an engine. */
export function rowsFor(input: {
  mapping: Mapping
  dataset: Dataset
}): Map<string, Array<Map<string, unknown>>> {
  const out = new Map<string, Array<Map<string, unknown>>>()

  for (const [mark, record] of input.dataset) {
    const table = tableFor(input.mapping, record.type)

    if (!table) {
      continue
    }

    const rows = out.get(table.table) ?? []
    const row = new Map<string, unknown>(rowOf(table, record))
    row.set(table.markColumn, mark)
    rows.push(row)
    out.set(table.table, rows)
  }

  return out
}
