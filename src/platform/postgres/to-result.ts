/**
 * Normalising a `pg` result into the shape the rest of the codebase reads.
 *
 * Shared by every DataSource implementation so `DbResult` is assembled in one
 * place — in particular `columns`, which comes from the field descriptor rather
 * than from the rows and is therefore still right when nothing matched.
 */

import type { DbResult } from "./types/db-result.js";
import type { DbRow } from "./types/db-row.js";

export function toResult<T extends DbRow>(result: {
  rows: any[];
  rowCount: number | null;
  fields?: { name: string }[];
}): DbResult<T> {
  return {
    rows: result.rows,
    rowCount: result.rowCount ?? 0,
    columns: (result.fields ?? []).map((f) => f.name),
  };
}
