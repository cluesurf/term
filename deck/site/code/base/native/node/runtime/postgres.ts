// Postgres runtime shim (node). Wraps the `pg` driver in a flat namespace of total functions so the seed `native/node/db`
// impl can dock it as `<global:postgres>` without ever expressing the `new Pool(...)` constructor or promise plumbing.
// The build prepends this prelude; nothing in userland imports `pg`.
import pg from 'pg'

const postgres = {
  pool: null as InstanceType<typeof pg.Pool> | null,
  connect(url: string): void {
    postgres.pool = new pg.Pool(url ? { connectionString: url } : {})
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
