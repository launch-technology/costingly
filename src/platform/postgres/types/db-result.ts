/** What a statement returns. */

import type { DbRow } from "./db-row.js";

export interface DbResult<T extends DbRow = DbRow> {
  rows: T[];
  /** Rows affected by INSERT/UPDATE/DELETE. 0 for SELECT-shaped statements. */
  rowCount: number;
  /**
   * Column names in select order.
   *
   * Comes from the result descriptor, not from the rows, so it is still correct
   * when the query matched nothing — which is exactly when a caller most needs
   * to know what shape the answer would have had.
   */
  columns: string[];
}
