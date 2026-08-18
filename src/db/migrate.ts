/**
 * Migrations — the only thing that shapes the database.
 *
 * Numbered `.sql` files in `migrations/`, applied in filename order, each one
 * recorded so it never runs twice. `schema_migrations` is the whole truth about
 * what a given database has had done to it.
 *
 * WHY THIS RUNS ITSELF
 *
 * `costingly migrate` used to be a step a person ran. That works at a terminal
 * and fails completely for a bundled install, which has no terminal and no hook
 * between "user clicks install" and "user asks a question" — the first tool call
 * IS the setup. So this happens on the first database connection, next to the
 * two things already in that position: starting the cluster and creating the
 * database. All three are state the program can produce for itself.
 *
 * WHY NOT ONE IDEMPOTENT schema.sql
 *
 * That was the previous design and it has a hole. `CREATE TABLE IF NOT EXISTS`
 * is a no-op on a table that already exists — it does not compare definitions.
 * So adding a column to an existing install would silently do nothing while the
 * bookkeeping recorded success, and the failure would surface much later as a
 * missing column. Views and comments re-apply cleanly that way; tables do not,
 * and tables are where the irreversible changes live.
 *
 * A ledger of what has run has no such gap, and it is one mechanism rather than
 * two. The cost is that changing a view means writing its DROP/CREATE into a new
 * file rather than editing one in place — a fair trade, since a view change IS a
 * change and reviewing it as a discrete unit is no worse.
 *
 * WHERE THE FILES COME FROM
 *
 * Not from here. Reading `migrations/` means resolving a path from
 * `import.meta.url`, and src/ deliberately does not (see the header of
 * cli/paths.ts). The entry point registers a loader; this module calls it.
 * Nothing registered means no automatic migration — the right default for code
 * embedding this module rather than running the CLI.
 */

import type { DbClient } from "./client.js";

export interface Migration {
  /** Filename without extension — "0001-initial". The ledger key. */
  id: string;
  sql: string;
}

/**
 * Advisory lock id, arbitrary but fixed. Two processes starting at once — an
 * MCP server and a CLI sync, say — would otherwise both try to apply the same
 * pending files.
 */
const LOCK_ID = 0x0c05_7147; // "costingly", squinting

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

/**
 * Ids already applied, or null when the ledger itself does not exist yet.
 *
 * Asked with to_regclass rather than by running a SELECT and catching the
 * error: inside a transaction, ANY error aborts the whole transaction, so
 * provoking one here would poison the migration that follows it.
 */
async function appliedIds(client: DbClient): Promise<Set<string> | null> {
  const { rows } = await client.query<{ present: string | null }>(
    `SELECT to_regclass('public.schema_migrations')::text AS present`,
  );
  if (rows[0]?.present == null) return null;

  const { rows: ids } = await client.query<{ id: string }>(`SELECT id FROM schema_migrations`);
  return new Set(ids.map((r) => r.id));
}

/** Which of `migrations` this database has not run, in order. */
export async function pendingMigrations(
  client: DbClient,
  migrations: readonly Migration[],
): Promise<Migration[]> {
  const applied = await appliedIds(client);
  if (applied === null) return [...migrations];
  return migrations.filter((m) => !applied.has(m.id));
}

/**
 * Apply everything pending, inside one transaction holding an advisory lock.
 *
 * One transaction for the whole run, not one per file: a half-migrated database
 * is worse than an unmigrated one, and there is no migration here long enough to
 * make the lock hold a problem. (The exception, if one is ever needed, is
 * CREATE INDEX CONCURRENTLY — which cannot run inside a transaction at all and
 * would need its own path.)
 *
 * The pending set is recomputed inside the lock, so a process that waited on
 * another one finishing finds nothing to do rather than applying twice.
 */
export async function runMigrations(
  client: DbClient,
  migrations: readonly Migration[],
): Promise<string[]> {
  await client.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK_ID]);
  await client.query(LEDGER);

  const pending = await pendingMigrations(client, migrations);
  for (const migration of pending) {
    // No parameters, so pg uses the simple query protocol — which is what lets
    // a multi-statement file run as one call.
    await client.query(migration.sql);
    await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [migration.id]);
  }

  return pending.map((m) => m.id);
}
