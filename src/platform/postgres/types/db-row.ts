/**
 * A row as it comes back from Postgres.
 *
 * Plain objects — column types are decided by the type parsers the pool
 * registers, not here.
 */
export type DbRow = Record<string, any>;
