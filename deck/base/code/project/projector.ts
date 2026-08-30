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
import {
  admit,
  health as healthOf,
  type Freshness,
  type Health,
  type LagBound,
  type LagState,
  type Served,
} from '@term/base/code/project/lag'
import { mappingVersion } from '@term/base/code/project/version'
import {
  planQuery,
  toSelect,
  type Plan,
  type Query,
} from '@term/base/code/project/query'

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

/**
 * A recorded rebuild proof: this projection was shown to rebuild identically.
 *
 * `tables` is what the proving run covered, never the whole projection, because a run
 * proves the tables it was handed. A reader that ignores it turns one table's proof into a
 * claim about all of them.
 */
export type Proof = {
  commit: string
  at: number
  tables: Array<string>
}

export type ProjectionState = {
  repository: string
  commit: string | undefined
}

/**
 * The outcome of applying a span.
 *
 * `lost` means the compare-and-swap in `recordServing` found the watermark already moved,
 * so another projector advanced first and this whole transaction rolled back. Nothing was
 * written. A caller re-reads the watermark and tries again, because the span it computed
 * was against a starting point that no longer holds.
 */
export type ApplyResult = {
  applied: boolean
  writes: number
  lost?: boolean
}

/**
 * Thrown inside the apply transaction purely to roll it back when the fence is lost.
 *
 * Never escapes `apply`, which turns it into `{ lost: true }`. It exists because returning
 * early from inside `engine.transact` would COMMIT the row writes while the watermark still
 * named an older commit.
 */
class FenceLost extends Error {
  constructor() {
    super('the projection watermark moved while this span was being applied')
    this.name = 'FenceLost'
  }
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
    // injected so lag is measured against one clock, and so tests are deterministic
    private readonly now: () => number = Date.now,
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
    covers?: Array<string>
    // The serving commit the caller read before computing this span. When given, the
    // watermark write becomes a compare-and-swap against it and the whole transaction
    // rolls back if another projector advanced first. See `recordServing`.
    fence?: { at: string | undefined }
  }): Promise<ApplyResult> {
    if (await this.hasApplied(input.commit)) {
      return { applied: false, writes: 0 }
    }

    const writes = mergeWrites(
      writesFor({ mapping: this.mapping, changes: input.changes }),
    )

    // every commit this change set folds becomes present at once, so ALL of them are
    // logged as applied — a batched advance from `at` to `head` records every commit in
    // between, not just `head`, so a client that committed an intermediate commit reads
    // it as applied rather than "behind".
    const covers = input.covers ?? [input.commit]

    try {
      await this.engine.transact(async tx => {
        for (const write of writes) {
          await tx.run(toStatement(write))
        }

        for (const commit of covers) {
          await this.recordLog(tx, commit)
        }

        const won = await this.recordServing(tx, input.commit, input.fence)

        if (!won) {
          // Roll back by throwing. Returning here would COMMIT the row writes and the log
          // while the watermark still names an older commit, which is the exact split this
          // fence exists to prevent.
          throw new FenceLost()
        }
      })
    } catch (error) {
      if (error instanceof FenceLost) {
        return { applied: false, writes: 0, lost: true }
      }

      throw error
    }

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

  /**
   * Record a commit as applied, and advance the serving commit, in the caller's
   * transaction.
   *
   * The applied time is written EXPLICITLY from the projector's clock rather than left
   * to the column default. The default is the database's `now()`, so lag measured
   * against it would fold in clock skew between the projector and its engine, and would
   * differ between engines for no reason the caller could see.
   */
  // Record a commit as applied in the per-commit log (idempotent). Used for every
  // commit an application makes present, so read-your-writes membership is exact.
  private async recordLog(tx: Transaction, commit: string): Promise<void> {
    const applied = new Date(this.now()).toISOString()
    await tx.run({
      sql: `INSERT INTO ${quote(`${BOOKKEEPING_TABLE}_log`)} ("repository", "commit", "applied") VALUES ($1, $2, $3) ON CONFLICT ("repository", "commit") DO NOTHING`,
      params: [this.repository, commit, applied],
    })
  }

  /**
   * Record the commit the projection now serves (the target head), one row per
   * repository. Distinct from the log, which records every applied commit.
   *
   * With a `fence`, this is a COMPARE-AND-SWAP against the serving commit the caller read
   * before it computed the span, and it returns whether it won.
   *
   * The fence is what makes more than one projector safe, and commit-hash idempotence does
   * NOT provide it. Two projectors both reading `serving = A`, one applying the span A to C
   * and one applying A to B, both find their head absent from the log, so neither
   * short-circuits. Without the fence both transactions commit, the rows reflect whichever
   * wrote last, the watermark names whichever wrote last, and those need not be the same
   * one. A watermark naming a commit that does not describe the rows is silently wrong
   * forever.
   *
   * `IS NOT DISTINCT FROM` rather than `=`, so a fresh projection (`serving` is NULL) is
   * fenced like every other advance instead of being a hole in it.
   *
   * The insert path still runs unconditionally when no row exists. A missing watermark row
   * under a non-null expectation means someone reset the projection out from under us,
   * which is a rebuild rather than a race, and the log reconciles it on the next pass.
   */
  private async recordServing(
    tx: Transaction,
    commit: string,
    fence?: { at: string | undefined },
  ): Promise<boolean> {
    const applied = new Date(this.now()).toISOString()
    // The shape these rows were written through, stamped in the same transaction as the
    // rows themselves. A projection that cannot say which mapping produced it cannot be
    // told apart from one built through a mapping that no longer describes the schema.
    const version = mappingVersion(this.mapping)

    if (!fence) {
      await tx.run({
        sql: `INSERT INTO ${quote(BOOKKEEPING_TABLE)} ("repository", "commit", "applied", "mapping_version") VALUES ($1, $2, $3, $4) ON CONFLICT ("repository") DO UPDATE SET "commit" = EXCLUDED."commit", "applied" = EXCLUDED."applied", "mapping_version" = EXCLUDED."mapping_version"`,
        params: [this.repository, commit, applied, version],
      })

      return true
    }

    const rows = await tx.all({
      sql: `INSERT INTO ${quote(BOOKKEEPING_TABLE)} ("repository", "commit", "applied", "mapping_version") VALUES ($1, $2, $3, $4) ON CONFLICT ("repository") DO UPDATE SET "commit" = EXCLUDED."commit", "applied" = EXCLUDED."applied", "mapping_version" = EXCLUDED."mapping_version" WHERE ${quote(BOOKKEEPING_TABLE)}."commit" IS NOT DISTINCT FROM $5 RETURNING "commit"`,
      params: [this.repository, commit, applied, version, fence.at ?? null],
    })

    return rows.length > 0
  }

  /**
   * The mapping shape this projection's rows were last written through, and this build's.
   *
   * A mismatch means the schema moved under the projection: every row written before it is
   * missing whatever the new mapping adds, and still carries whatever it dropped. The
   * projection is current with every commit and stale in a way the lag contract cannot see.
   *
   * `stored` is undefined on a projection that predates versioning, which is not a mismatch.
   * It is an unknown, and treating it as a mismatch would trigger a rebuild on every
   * projection the first time this ships.
   */
  async mappingState(): Promise<{
    stored: string | undefined
    current: string
    matches: boolean
  }> {
    const rows = await this.engine.transact(tx =>
      tx.all({
        sql: `SELECT "mapping_version" FROM ${quote(BOOKKEEPING_TABLE)} WHERE "repository" = $1`,
        params: [this.repository],
      }),
    )

    const raw = rows[0]?.mapping_version
    const stored = typeof raw === 'string' ? raw : undefined
    const current = mappingVersion(this.mapping)

    return { stored, current, matches: stored === undefined || stored === current }
  }

  private async record(tx: Transaction, commit: string): Promise<void> {
    await this.recordLog(tx, commit)
    await this.recordServing(tx, commit)
  }

  /**
   * Quarantine this projection at its current commit, naming the commit that cannot apply.
   *
   * Pinning rather than skipping. Skipping a failing commit and continuing would leave the
   * projection reflecting a state no commit ever described, which is worse than being
   * behind: being behind is visible and being wrong is not.
   *
   * Written outside the apply transaction on purpose. The apply that provoked it has already
   * rolled back, so there is nothing to keep it company, and a pin that failed to record
   * because its transaction rolled back would be a quarantine nobody could see.
   */
  async pin(input: { commit: string; reason: string }): Promise<void> {
    await this.engine.transact(async tx => {
      await tx.run({
        sql: `UPDATE ${quote(BOOKKEEPING_TABLE)} SET "pinned_commit" = $2, "pinned_reason" = $3 WHERE "repository" = $1`,
        params: [this.repository, input.commit, input.reason],
      })
    })
  }

  /** Clear a quarantine, once whatever caused it has been dealt with. */
  async unpin(): Promise<void> {
    await this.engine.transact(async tx => {
      await tx.run({
        sql: `UPDATE ${quote(BOOKKEEPING_TABLE)} SET "pinned_commit" = $2, "pinned_reason" = $3 WHERE "repository" = $1`,
        params: [this.repository, null, null],
      })
    })
  }

  /** The commit this projection is quarantined on, if any. */
  async pinned(): Promise<{ commit: string; reason: string } | undefined> {
    const rows = await this.engine.transact(tx =>
      tx.all({
        sql: `SELECT "pinned_commit", "pinned_reason" FROM ${quote(BOOKKEEPING_TABLE)} WHERE "repository" = $1`,
        params: [this.repository],
      }),
    )

    const commit = rows[0]?.pinned_commit
    const reason = rows[0]?.pinned_reason

    return typeof commit === 'string'
      ? { commit, reason: typeof reason === 'string' ? reason : 'unknown' }
      : undefined
  }

  /**
   * Record that this projection was proved to rebuild identically at a commit.
   *
   * Written only on a PASS. A failed proof deliberately leaves the previous record standing
   * rather than clearing it: "last proved at X" and "last attempted at Y" are different
   * facts, and overwriting the first with a failure would destroy the only evidence that the
   * projection was ever trustworthy, at the exact moment somebody needs it.
   */
  async recordProof(input: {
    commit: string
    tables: Array<string>
  }): Promise<void> {
    const at = new Date(this.now()).toISOString()
    // sorted so the same set of tables reads the same however the run was invoked, which is
    // what lets two records be compared at all
    const tables = [...new Set(input.tables)].sort().join(',')

    await this.engine.transact(async tx => {
      await tx.run({
        sql: `UPDATE ${quote(BOOKKEEPING_TABLE)} SET "proved_commit" = $2, "proved" = $3, "proved_table" = $4 WHERE "repository" = $1`,
        params: [this.repository, input.commit, at, tables],
      })
    })
  }

  /** When this projection was last proved, at which commit, and over which tables. */
  async proof(): Promise<Proof | undefined> {
    const rows = await this.engine.transact(tx =>
      tx.all({
        sql: `SELECT "proved_commit", "proved", "proved_table" FROM ${quote(BOOKKEEPING_TABLE)} WHERE "repository" = $1`,
        params: [this.repository],
      }),
    )

    const row = rows[0]

    if (row === undefined || typeof row.proved_commit !== 'string') {
      return undefined
    }

    const when = row.proved
    const at =
      when instanceof Date
        ? when.getTime()
        : typeof when === 'string'
          ? Date.parse(when)
          : Number.NaN

    const tables = typeof row.proved_table === 'string' ? row.proved_table : ''

    return {
      commit: row.proved_commit,
      at: Number.isNaN(at) ? 0 : at,
      tables: tables === '' ? [] : tables.split(','),
    }
  }

  /** What the projection knows about its own currency. */
  async lagState(behind?: number): Promise<LagState> {
    const rows = await this.engine.transact(tx =>
      tx.all({
        sql: `SELECT "commit", "applied" FROM ${quote(BOOKKEEPING_TABLE)} WHERE "repository" = $1`,
        params: [this.repository],
      }),
    )

    return stateOf(rows[0], behind)
  }

  /**
   * Answer a query, subject to the lag contract.
   *
   * The freshness demand and the health bound are checked BEFORE the query runs, so an
   * unhealthy projection costs a caller nothing and, more importantly, cannot answer.
   * Every success carries the commit it was served at, so a result is as traceable as
   * the records behind it.
   */
  async read(input: {
    form: TableForm
    query: Query
    columns?: Array<string>
    freshness?: Freshness
    bound?: LagBound
    behind?: number
  }): Promise<Served<Array<Record<string, unknown>>> & { plan?: Plan }> {
    const freshness = input.freshness ?? { need: 'any' }
    const plan = planQuery(input.form, input.query)

    // rendered up front, so a malformed query throws before any transaction is opened
    // and is never mistaken for a freshness refusal
    const statement = toSelect({
      form: input.form,
      query: input.query,
      columns: input.columns,
    })

    // ONE transaction for the bookkeeping read, the demand check, and the rows. Reading
    // them separately would let a concurrent apply land in between, and the answer would
    // then report a serving commit that does not describe the rows it carries. That is
    // precisely the guarantee this contract exists to make, so it cannot be split.
    return this.engine.transact(async tx => {
      const bookkeeping = await tx.all({
        sql: `SELECT "commit", "applied" FROM ${quote(BOOKKEEPING_TABLE)} WHERE "repository" = $1`,
        params: [this.repository],
      })

      const state = stateOf(bookkeeping[0], input.behind)

      let hasCommit: boolean | undefined

      if (freshness.need === 'commit') {
        const found = await tx.all({
          sql: `SELECT "commit" FROM ${quote(`${BOOKKEEPING_TABLE}_log`)} WHERE "repository" = $1 AND "commit" = $2`,
          params: [this.repository, freshness.commit],
        })

        hasCommit = found.length > 0
      }

      const allowed = admit({
        state,
        bound: input.bound,
        freshness,
        hasCommit,
        now: this.now(),
      })

      if (!allowed.ok) {
        return allowed
      }

      const rows = await tx.all(statement)

      return { ok: true as const, rows, serving: allowed.serving, plan }
    })
  }

  /** Whether the projection is inside its lag bound. */
  async health(bound?: LagBound, behind?: number): Promise<Health> {
    return healthOf({
      state: await this.lagState(behind),
      bound,
      now: this.now(),
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

/**
 * A bookkeeping row as lag state.
 *
 * Shared by `read` and `lagState` so the two cannot decode the same row differently,
 * which would make a read's reported freshness disagree with a health check taken a
 * moment later.
 */
function stateOf(
  row: Record<string, unknown> | undefined,
  behind?: number,
): LagState {
  const serving = typeof row?.commit === 'string' ? row.commit : undefined
  const applied =
    typeof row?.applied === 'string' ? Date.parse(row.applied) : undefined

  return {
    serving,
    appliedAt: applied === undefined || Number.isNaN(applied) ? undefined : applied,
    behind,
  }
}
