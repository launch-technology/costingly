/**
 * The database as the application sees it.
 *
 * An Executor itself, so a caller with no transaction to join just passes it
 * where an Executor is wanted — there is no second way to reach the database
 * and therefore no way to accidentally escape a transaction by choosing it.
 *
 * The name is JDBC's: a factory for connections that also runs one-off
 * statements. The previous one, `Driver`, borrowed from `pg`, where a Driver is
 * the one thing that does not execute SQL.
 */

import type { Executor } from "./executor.js";
import type { Transaction } from "./transaction.js";

export interface DataSource extends Executor {
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Human-readable description of where data is going. For status output. */
  describe(): string;
}
