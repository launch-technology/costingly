/**
 * Turning rows into something a model reads well and cheaply.
 *
 * The obvious answer is JSON.stringify, and it is the wrong one. JSON repeats
 * every column name on every row:
 *
 *     [{"category":"FOOD_AND_DRINK","total":"1234.56"}, {"category":"TRANSPORT...
 *
 * At 200 rows that is 200 copies of the word "category" — pure cost, since the
 * header already said it once. A delimited table with one header line runs
 * roughly half the tokens for a wide result and reads no worse.
 *
 * Three things this format is careful about:
 *
 *   NULL      rendered as the literal NULL, so it is distinguishable from an
 *             empty string. "" and NULL mean genuinely different things in a
 *             merchant_name column and a model should not have to guess.
 *   numbers   NUMERIC arrives from pg as a string and DATE as "YYYY-MM-DD", by
 *             deliberate choice in db/client.ts. Passing them through unquoted
 *             preserves the exact value with no float rounding.
 *   emptiness   zero rows still prints the header, because "no results" and
 *             "no such column" are different answers and the column list is the
 *             difference.
 */

import type { DbRow } from "../db/client.js";
import type { ReadOnlyResult } from "../db/readonly.js";

/** Separator. Chosen over a tab because tabs are invisible when debugging. */
const SEP = " | ";

/** Render one value. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * A result set as a header line plus one line per row.
 *
 * `columns` comes from the result descriptor rather than the rows, so an empty
 * result still reports its shape.
 */
export function formatRows(result: ReadOnlyResult): string {
  const { rows, columns, truncated, rowCap } = result;

  if (columns.length === 0) {
    return "Query returned no columns.";
  }

  const lines: string[] = [];
  lines.push(columns.join(SEP));
  lines.push(columns.map((c) => "-".repeat(Math.max(3, c.length))).join(SEP));

  for (const row of rows as DbRow[]) {
    lines.push(columns.map((c) => cell(row[c])).join(SEP));
  }

  const body = lines.join("\n");

  if (rows.length === 0) {
    return `${body}\n\n(0 rows — the query ran and matched nothing. The columns above are real, so this is an empty result, not a bad query.)`;
  }

  const summary = truncated
    ? `\n\n(${rowCap} rows shown; MORE MATCHED AND WERE DROPPED. Do not treat this as a ` +
      `complete set — add a LIMIT to say you meant it, or aggregate with GROUP BY / SUM to ` +
      `get an answer over everything.)`
    : `\n\n(${rows.length} row${rows.length === 1 ? "" : "s"})`;

  return body + summary;
}
