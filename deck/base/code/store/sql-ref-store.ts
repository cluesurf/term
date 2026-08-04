// A mutable ref store backed by a Postgres-wire database (CockroachDB or PostgreSQL),
// mirroring how the platform reaches its database through Kysely over pg (a platform package/code/
// tool/db). Refs are the small mutable part of the store, the branch heads, updated by
// compare-and-swap so concurrent commits serialize. Chunks are immutable and live in
// object storage; refs are transactional and live here. base depends only on the
// minimal SqlClient interface below, not on the driver.
//
// The table and column names are configurable, so this fits an existing schema. The
// column map is keyed by the camelCase name base uses in code (e.g. `creationTimestamp`)
// and valued by the database column (default `creation__timestamp`, the mesh
// convention), so JS stays camelCase while the database keeps its own naming.
//
// See note/library/base/design/storage-backend.md and
// note/library/base/design/consistency-and-concurrency.md.

// The minimal executor base needs: run a parameterized statement, get rows back.
// A Kysely/pg deployment implements this by compiling to the same SQL; the in-memory
// implementation below emulates it.
export interface SqlClient {
  query<Row>(sql: string, params: Array<unknown>): Promise<Array<Row>>
}

// The async ref-store contract: name -> hash, with compare-and-swap.
export interface AsyncRefStore {
  get(name: string): Promise<string | undefined>
  compareAndSwap(
    name: string,
    expected: string | undefined,
    next: string,
  ): Promise<boolean>
  list(): Promise<Array<string>>
}

// The database column for each field base stores. Keys are base's camelCase names;
// values are the actual column identifiers.
export type RefColumns = {
  name: string
  hash: string
  creationTimestamp: string
  mutationTimestamp: string
}

// Defaults follow mesh: content-addressed TEXT columns and double-underscore
// TIMESTAMPTZ event columns.
export const DEFAULT_REF_COLUMNS: RefColumns = {
  name: 'name',
  hash: 'hash',
  creationTimestamp: 'creation__timestamp',
  mutationTimestamp: 'mutation__timestamp',
}

export const DEFAULT_REF_TABLE = 'ref'

export type SqlRefOptions = {
  // the table name (default `ref`)
  table?: string
  // per-field overrides of the database column names
  columns?: Partial<RefColumns>
}

// Quote an SQL identifier, escaping embedded quotes.
function q(id: string): string {
  return `"${id.replace(/"/g, '""')}"`
}

type Dialect = 'cockroachdb' | 'postgres'

// The generic SQL ref store. CockroachDB and PostgreSQL share the Postgres wire
// protocol and this exact SQL (INSERT ... ON CONFLICT, conditional UPDATE, RETURNING),
// so both dialects subclass this with only their name differing. The statements are
// built once from the configured table and columns.
export class SqlRefStore implements AsyncRefStore {
  readonly table: string
  readonly columns: RefColumns
  readonly dialect: Dialect
  private readonly ddlSql: string
  private readonly selectSql: string
  private readonly insertSql: string
  private readonly updateSql: string
  private readonly listSql: string

  constructor(
    private sql: SqlClient,
    opts: SqlRefOptions = {},
    dialect: Dialect = 'postgres',
  ) {
    this.dialect = dialect
    this.table = opts.table ?? DEFAULT_REF_TABLE
    this.columns = { ...DEFAULT_REF_COLUMNS, ...opts.columns }
    const t = q(this.table)
    const c = this.columns
    // SELECT and RETURNING alias to base's camelCase names so returned rows are stable
    // regardless of the database column names.
    this.ddlSql = `CREATE TABLE IF NOT EXISTS ${t} (
  ${q(c.name)} TEXT PRIMARY KEY,
  ${q(c.hash)} TEXT NOT NULL,
  ${q(c.creationTimestamp)} TIMESTAMPTZ NOT NULL DEFAULT now(),
  ${q(c.mutationTimestamp)} TIMESTAMPTZ NOT NULL DEFAULT now()
)`
    this.selectSql = `SELECT ${q(c.hash)} AS "hash" FROM ${t} WHERE ${q(c.name)} = $1`
    this.insertSql = `INSERT INTO ${t} (${q(c.name)}, ${q(c.hash)}) VALUES ($1, $2) ON CONFLICT (${q(c.name)}) DO NOTHING RETURNING ${q(c.name)} AS "name"`
    this.updateSql = `UPDATE ${t} SET ${q(c.hash)} = $2, ${q(c.mutationTimestamp)} = now() WHERE ${q(c.name)} = $1 AND ${q(c.hash)} = $3 RETURNING ${q(c.name)} AS "name"`
    this.listSql = `SELECT ${q(c.name)} AS "name" FROM ${t}`
  }

  // The CREATE TABLE statement for this store's configuration. Ship it as a migration
  // (a platform migration) in a real deployment.
  ddl(): string {
    return this.ddlSql
  }

  // Create the ref table if absent.
  async init(): Promise<void> {
    await this.sql.query(this.ddlSql, [])
  }

  async get(name: string): Promise<string | undefined> {
    const rows = await this.sql.query<{ hash: string }>(this.selectSql, [name])
    return rows[0]?.hash
  }

  // Atomic compare-and-swap: an insert (guarded by ON CONFLICT DO NOTHING) when the ref
  // is expected to be absent, or a conditional update when it is expected to hold a
  // given hash. The RETURNING row count tells us whether we won.
  async compareAndSwap(
    name: string,
    expected: string | undefined,
    next: string,
  ): Promise<boolean> {
    if (expected === undefined) {
      const rows = await this.sql.query<{ name: string }>(this.insertSql, [name, next])
      return rows.length === 1
    }
    const rows = await this.sql.query<{ name: string }>(this.updateSql, [
      name,
      next,
      expected,
    ])
    return rows.length === 1
  }

  async list(): Promise<Array<string>> {
    const rows = await this.sql.query<{ name: string }>(this.listSql, [])
    return rows.map(r => r.name)
  }
}

// A CockroachDB-backed ref store. CockroachDB serializes the compare-and-swap through
// its distributed transactions, so branch heads stay consistent across nodes.
export class CockroachRefStore extends SqlRefStore {
  constructor(sql: SqlClient, opts: SqlRefOptions = {}) {
    super(sql, opts, 'cockroachdb')
  }
}

// A PostgreSQL-backed ref store. Same SQL and semantics; a single-primary Postgres
// serializes the compare-and-swap on the row.
export class PostgresRefStore extends SqlRefStore {
  constructor(sql: SqlClient, opts: SqlRefOptions = {}) {
    super(sql, opts, 'postgres')
  }
}

// The default-schema DDL, for reference and back-compat. Prefer `store.ddl()`, which
// reflects any configured names.
export const REF_TABLE_DDL = new SqlRefStore(
  { query: () => Promise.resolve([]) },
  {},
).ddl()

// In-memory SqlClient emulating the ref statements, for tests and local runs. It reads
// the operation from the statement keyword and uses the store's fixed parameter order,
// so it works for any configured table or column names.
export class MemorySqlClient implements SqlClient {
  private refs = new Map<string, string>()

  query<Row>(sql: string, params: Array<unknown>): Promise<Array<Row>> {
    const head = sql.trimStart().slice(0, 12).toUpperCase()
    if (head.startsWith('CREATE TABLE')) {
      return Promise.resolve([])
    }
    if (head.startsWith('SELECT')) {
      if (/where/i.test(sql)) {
        const hash = this.refs.get(params[0] as string)
        return Promise.resolve(hash === undefined ? [] : ([{ hash }] as Array<Row>))
      }
      return Promise.resolve(
        [...this.refs.keys()].map(name => ({ name })) as Array<Row>,
      )
    }
    if (head.startsWith('INSERT')) {
      const name = params[0] as string
      if (this.refs.has(name)) {
        return Promise.resolve([]) // ON CONFLICT DO NOTHING
      }
      this.refs.set(name, params[1] as string)
      return Promise.resolve([{ name }] as Array<Row>)
    }
    if (head.startsWith('UPDATE')) {
      const name = params[0] as string
      const next = params[1] as string
      const expected = params[2] as string
      if (this.refs.get(name) !== expected) {
        return Promise.resolve([])
      }
      this.refs.set(name, next)
      return Promise.resolve([{ name }] as Array<Row>)
    }
    throw new Error(`unrecognized statement: ${sql}`)
  }
}
