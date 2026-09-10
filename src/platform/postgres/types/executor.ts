/**
 * Anything SQL can be run against.
 *
 * Both the pool and an open transaction satisfy this, which is what lets a
 * repository function be written once and work in either. It says nothing about
 * *which* connection the statement lands on — see `Transaction` for when that
 * matters.
 *
 * The name is JDBC's neighbourhood, deliberately. The previous one, `DbClient`,
 * borrowed from `pg`, where `Client` means a physical connection — which this
 * is not.
 */

import type { DbResult } from "./db-result.js";
import type { DbRow } from "./db-row.js";

export interface Executor {
  query<T extends DbRow = DbRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<DbResult<T>>;
}
