/**
 * Turning a database failure into something a model can act on.
 *
 * Lives here, not in data/, because deciding what a model should be told is a
 * protocol decision. PostgreSQL's own DETAIL and HINT are usually the exact
 * correction needed, so they are passed through; only the setup errors it
 * cannot act on are replaced.
 */

import { isMissingSchema } from "../../../data/db/errors.js";

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
