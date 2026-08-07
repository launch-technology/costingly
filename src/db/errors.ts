/**
 * Turning a database failure into something worth reading.
 *
 * Two audiences, and they want opposite things.
 *
 * A **person** at a terminal wants to know what to do next. "relation
 * v_transactions does not exist" tells them nothing; "run costingly init" tells
 * them everything.
 *
 * A **model** that just wrote a query wants the raw text, because Postgres is
 * unusually good at saying what went wrong:
 *
 *     column "catgory" does not exist
 *     HINT:  Perhaps you meant to reference the column "v_transactions.category".
 *
 * That hint is the entire mechanism by which the next attempt succeeds.
 * Wrapping it in "query failed" throws away the only useful part.
 *
 * So the split is not raw-versus-friendly. It is: can the caller act on it?
 *
 *   the caller's own mistake     pass it through verbatim, hint and all
 *   an environment problem       replace it with the instruction that fixes it
 *
 * A model can fix its SQL. It cannot run `costingly init`. Telling it "relation
 * does not exist" for an un-migrated database invites it to guess other table
 * names forever, because that message looks like a typo it could correct.
 */

/** The subset of a `pg` error we care about. */
interface PgError {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
}

function asPgError(error: unknown): PgError | null {
  if (typeof error !== "object" || error === null) return null;
  return error as PgError;
}

/**
 * Postgres `undefined_table` — the schema has never been applied.
 *
 * On a fresh install this is the first thing anyone hits: the cluster starts
 * itself and the database is created automatically, so everything looks healthy
 * until the first real query.
 */
export function isMissingSchema(error: unknown): boolean {
  return asPgError(error)?.code === "42P01";
}

/** What to tell a person at a terminal when the schema is missing. */
export const MISSING_SCHEMA_CLI =
  "The database has not been set up yet.\n\n" +
  "  costingly init      set up credentials and create it\n" +
  "  costingly migrate   just create the tables";

/**
 * What to tell a model when the schema is missing.
 *
 * Phrased as an instruction about what to do, not a description of state,
 * because the model's alternative is to retry — and retrying cannot work.
 */
export const MISSING_SCHEMA_MCP =
  "costingly has no schema yet, so there is nothing to query. This is a setup " +
  "step, not a problem with the query — retrying or trying different table " +
  "names will not help. Tell the user to run `costingly migrate` (or " +
  "`costingly init` if they have not configured Plaid credentials yet), then " +
  "`costingly sync` to load their transactions.";

/**
 * Explain a database error to a model.
 *
 * Everything except the setup case is passed through with its DETAIL and HINT,
 * which are the parts that let a wrong query become a right one.
 */
export function explainDbError(error: unknown): string {
  if (isMissingSchema(error)) return MISSING_SCHEMA_MCP;

  const pg = asPgError(error);
  const message =
    pg?.message ?? (error instanceof Error ? error.message : String(error));

  const parts = [message];
  if (pg?.detail) parts.push(`DETAIL: ${pg.detail}`);
  if (pg?.hint) parts.push(`HINT: ${pg.hint}`);
  return parts.join("\n");
}
