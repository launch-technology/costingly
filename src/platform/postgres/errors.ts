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
 * The cluster exists and accepts connections, but nothing has created the
 * tables in it. A half-provisioned profile, or one whose migrations were
 * interrupted.
 */
export function isMissingSchema(error: unknown): boolean {
  return asPgError(error)?.code === "42P01";
}

/**
 * There is no database here, and this caller is not allowed to make one.
 *
 * Thrown by the ordinary query path when the cluster has never been created.
 * Creating one is a deliberate act — it runs `initdb`, writes a cluster to the
 * user's disk and generates credentials — so it belongs to callers that asked
 * for it, never to whichever `SELECT` happened to run first.
 *
 * Its own class rather than a message, because the difference between "not set
 * up yet" and "set up and broken" is the difference between offering to install
 * and reporting a fault, and no interface should have to match on prose to tell
 * them apart.
 */
export class DatabaseNotSetUpError extends Error {
  readonly notSetUp = true;

  constructor(message: string) {
    super(message);
    this.name = "DatabaseNotSetUpError";
  }
}

/** True if this failure means "nothing is installed", not "something broke". */
export function isNotSetUp(error: unknown): error is DatabaseNotSetUpError {
  return error instanceof DatabaseNotSetUpError;
}
