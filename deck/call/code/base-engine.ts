/**
 * A Postgres engine for the CLI, loaded only if it is asked for.
 *
 * `@term/base` is transport-free and driver-free on purpose, and that is why a projection
 * could be described from the command line and never written: the package that knows about
 * databases lives in mesh, which is an application rather than a tool anyone can install.
 *
 * So the driver is OPTIONAL AND LAZY. `pg` is imported at the moment a projection is
 * actually written, never at startup, so:
 *
 *   every offline verb keeps working with `pg` absent, which is most of them
 *   `term base` installs and runs with no database anywhere near it
 *   a user who wants to project installs one package and is told exactly which
 *
 * A hard dependency would make every `term base log` pay for a Postgres client, and a new
 * package to hold this would be a package that exists to hold twenty lines.
 *
 * The engine seam is `{ dialect, transact }` and nothing else, which is what makes this
 * small: everything above it is dialect-free, so a second engine is another adapter rather
 * than a second projector.
 */

import type { Engine, Transaction } from '@term/base/code/project/projector'

/** What `pg` gives us, narrowed to what an engine needs. */
type Client = {
  query: (sql: string, params: Array<unknown>) => Promise<{ rows: Array<Record<string, unknown>> }>
  release: () => void
}

type Pool = {
  connect: () => Promise<Client>
  end: () => Promise<void>
}

/**
 * Open a pool, or explain what to install.
 *
 * The message names the package and the command, because "cannot find module 'pg'" from
 * inside a CLI tells a person nothing about what they were supposed to do.
 */
export async function openPostgres(url: string): Promise<Pool> {
  let pg: { Pool: new (config: { connectionString: string }) => Pool }

  try {
    pg = (await import('pg')) as unknown as {
      Pool: new (config: { connectionString: string }) => Pool
    }
  } catch {
    throw new Error(
      'writing a projection needs a Postgres driver, and `pg` is not installed.\n' +
        'It is deliberately optional, so every other verb works without a database:\n' +
        '  pnpm add pg\n' +
        'Then run this again.',
    )
  }

  // `pg` is CommonJS, so the constructor may arrive on `default` depending on how the
  // module was interoperated. Checking both is one line and avoids a confusing crash.
  const Ctor =
    pg.Pool ??
    (pg as unknown as { default?: { Pool: new (c: { connectionString: string }) => Pool } })
      .default?.Pool

  if (!Ctor) {
    throw new Error('the installed `pg` does not export a Pool')
  }

  return new Ctor({ connectionString: url })
}

/**
 * An engine over a pool.
 *
 * Every `transact` takes ONE connection and wraps the body in a real transaction, because
 * the projector's whole correctness argument is that a commit's row writes and its
 * bookkeeping land together. Running them on separate pooled connections would let a crash
 * between them leave a projection that has the rows and not the watermark, which reads as
 * "never applied" and replays.
 */
export function postgresEngine(pool: Pool): Engine {
  return {
    dialect: 'postgres',

    async transact<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
      const client = await pool.connect()

      try {
        await client.query('BEGIN', [])

        const tx: Transaction = {
          async run(statement) {
            await client.query(statement.sql, statement.params)
          },
          async all(statement) {
            const { rows } = await client.query(statement.sql, statement.params)

            return rows
          },
        }

        const out = await body(tx)

        await client.query('COMMIT', [])

        return out
      } catch (error) {
        // Rolled back before rethrowing, so a failed apply leaves nothing behind. Swallowing
        // a failed rollback keeps the original error, which is the one worth reading.
        await client.query('ROLLBACK', []).catch(() => undefined)

        throw error
      } finally {
        client.release()
      }
    },
  }
}
