// Postgres runtime shim (node). Wraps the `pg` driver in a flat namespace of total functions so the seed `native/node/db`
// impl can dock it as `<global:postgres>` without ever expressing the `new Pool(...)` constructor or promise plumbing.
// The build prepends this prelude; nothing in userland imports `pg`.
//
// `pg` is loaded when a program CONNECTS, not when the prelude loads: a program whose imports reach the db module only
// for a form (the blog's `post`, drawn in a terminal with a store that keeps nothing) never touches a database, and
// requiring the driver at load made it fail where `pg` is not installed (terminal-target-0005, 2026-10-03).
import type pg from 'pg'
import { createRequire } from 'node:module'

const postgres = {
  pool: null as InstanceType<typeof pg.Pool> | null,
  connect(url: string): void {
    const driver = createRequire(import.meta.url)('pg') as typeof pg
    postgres.pool = new driver.Pool(url ? { connectionString: url } : {})
  },
  async query(
    sql: string,
    params: Array<unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await postgres.pool!.query(sql, params)
    return result.rows
  },
  async run(sql: string, params: Array<unknown>): Promise<void> {
    await postgres.pool!.query(sql, params)
  },
  field(row: Record<string, unknown>, name: string): string {
    const value = row?.[name]
    return value == null ? '' : String(value)
  },
  async close(): Promise<void> {
    await postgres.pool?.end()
    postgres.pool = null
  },
}
