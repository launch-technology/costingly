/**
 * Postgres access — a single pooled `pg.Pool` for the whole process.
 *
 * The pool is created lazily and cached on `globalThis`. That matters in two
 * places: Next.js dev-server hot reloads re-evaluate modules (without the cache
 * you leak a pool per reload), and serverless functions reuse a warm container
 * across invocations (with the cache you reuse the connections instead of
 * opening new ones on every cron tick).
 */

// `pg` is CommonJS and has no default export of its own, so the value side is
// imported as a synthetic default and destructured; the type side is imported
// with `import type`. (`import { Pool } from "pg"` is not reliable under Node's
// ESM/CJS interop.)
import pgPkg from "pg";
import type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
import { config } from "./config.js";

const { Pool: PgPool, types } = pgPkg;

export type { PoolClient, QueryResult, QueryResultRow } from "pg";

// ---------------------------------------------------------------------------
// Type parsers
// ---------------------------------------------------------------------------
// node-postgres returns DATE (OID 1082) as a JS Date built in the *local*
// timezone, which shifts "2026-03-14" to the previous day west of UTC. Plaid
// dates are plain calendar days with no time component, so keep them as the
// "YYYY-MM-DD" string Postgres sent.
types.setTypeParser(1082, (value: string) => value);

// NUMERIC (OID 1700) is intentionally left as a string. Parsing it to a JS
// number would reintroduce the float rounding that NUMERIC exists to avoid.

/**
 * Enable TLS unless we are talking to a local database.
 *
 * Hosted serverless Postgres (Neon, Supabase, Vercel Postgres) requires TLS but
 * commonly presents a certificate chain that Node does not trust out of the
 * box, hence `rejectUnauthorized: false` — the standard configuration for these
 * providers. The local docker container speaks plaintext, so SSL is skipped.
 */
function sslConfig(connectionString: string): PoolConfig["ssl"] {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    // Not a URL we can parse (e.g. a key=value DSN). Be conservative and let
    // pg decide from the connection string itself.
    return undefined;
  }

  // `new URL()` keeps IPv6 literals in brackets, e.g. "[::1]".
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local");

  return isLocal ? undefined : { rejectUnauthorized: false };
}

function createPool(): Pool {
  const connectionString = config.databaseUrl;

  const pool = new PgPool({
    connectionString,
    ssl: sslConfig(connectionString),
    // Serverless containers are short-lived and the platform caps connections,
    // so stay small. A daily sync is not throughput-bound.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  // Without this, a backend terminated by the server (idle timeout, failover,
  // a serverless pooler recycling the connection) surfaces as an unhandled
  // 'error' event and takes the process down. pg evicts the dead client itself;
  // we just need to not crash.
  pool.on("error", (err: Error) => {
    console.error("[db] idle client error (connection will be recycled):", err.message);
  });

  return pool;
}

// Cached across hot reloads / warm invocations.
const globalForPg = globalThis as typeof globalThis & {
  __plaidSyncPool?: Pool | undefined;
};

export function getPool(): Pool {
  const existing = globalForPg.__plaidSyncPool;
  if (existing) return existing;

  const pool = createPool();
  globalForPg.__plaidSyncPool = pool;
  return pool;
}

/** Run a one-off query on a pooled connection. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params ? [...params] : undefined);
}

/**
 * Run `fn` inside a single BEGIN/COMMIT on one dedicated connection.
 *
 * Every write for a given Plaid Item goes through here, so a run either applies
 * all of that item's changes *and* advances its cursor, or applies none of
 * them. There is no state where the cursor has moved past changes that were
 * never written — which is exactly what makes the sync safely re-runnable.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "[db] ROLLBACK failed:",
        rollbackError instanceof Error ? rollbackError.message : rollbackError,
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close the pool. Call this at the end of a CLI run so the process can exit.
 *
 * Do NOT call it from a serverless handler — the container is reused between
 * invocations and closing the pool throws away warm connections.
 */
export async function closePool(): Promise<void> {
  const pool = globalForPg.__plaidSyncPool;
  if (!pool) return;
  globalForPg.__plaidSyncPool = undefined;
  await pool.end();
}
