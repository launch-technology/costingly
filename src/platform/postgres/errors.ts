/**
 * Recognising database failures by their Postgres error code.
 *
 * Only classification lives here — what to *say* about a failure differs by
 * surface (a terminal message, an explanation aimed at a model), so that
 * decision stays with each app.
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
