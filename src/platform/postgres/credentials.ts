/**
 * Who may connect to the cluster, and how.
 *
 * Two logins, and the split is the point:
 *
 *   superuser   creating the cluster, creating the database, running migrations
 *               Never pooled. One-off connections, opened and closed around the
 *               work that needs them.
 *   app         every tool, every CLI path, every query this codebase writes.
 *               No DDL. `RESET ROLE` on one of its connections returns to
 *               itself, so nothing an LLM can reach has a ladder to superuser.
 *
 * A third role, `role_readonly`, has no login at all — the app role is a member
 * and drops into it with `SET LOCAL ROLE` for the duration of a single
 * transaction. See `queryReadOnly` in queries.ts.
 *
 * Portable: this file builds strings from values it is given. It reads no
 * config and opens no connections.
 */

/** The roles a project's migrations create. Constants, never built from input. */
export const ROLE_SUPERUSER = "u_superuser";
export const ROLE_APP = "u_app";
export const ROLE_READONLY = "role_readonly";

export type DbIdentity = "superuser" | "app";

export interface DbLogin {
  user: string;
  password: string;
}

export interface DbCredentials {
  host: string;
  port: number;
  /** The application database. `postgres` is used only to create it. */
  database: string;
  logins: Record<DbIdentity, DbLogin>;
}

/**
 * A libpq connection string for one identity.
 *
 * Every component is percent-encoded. A generated password is base64url and
 * needs no escaping today, but a connection string is a URL and treating it as
 * one costs nothing — and the day a password format changes, this does not
 * become a parsing bug.
 */
export function connectionStringFor(
  credentials: DbCredentials,
  identity: DbIdentity,
  database = credentials.database,
): string {
  const login = credentials.logins[identity];
  const user = encodeURIComponent(login.user);
  const password = encodeURIComponent(login.password);
  const host = encodeURIComponent(credentials.host);

  return `postgresql://${user}:${password}@${host}:${credentials.port}/${encodeURIComponent(database)}`;
}
