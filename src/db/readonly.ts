/**
 * Running SQL that somebody else wrote.
 *
 * This exists so a language model can be handed the keys to a database holding
 * encrypted bank credentials without that being a bad idea. The whole design
 * rests on one decision: **the SQL is never inspected.**
 *
 * Checking that a statement starts with SELECT, or blocklisting DROP, cannot be
 * made to work. Postgres allows data-modifying CTEs, so a destructive statement
 * can begin with the word WITH:
 *
 *     WITH gone AS (DELETE FROM transactions RETURNING *) SELECT count(*) FROM gone
 *
 * Comments hide keywords, string literals contain them innocently, and `;`
 * appends a second statement. Every such filter is a guess about a grammar we
 * do not implement. So we do not guess — we make the database refuse.
 *
 * Four guards, none of which subsumes another:
 *
 *   SET TRANSACTION READ ONLY   rejects every write, including the CTE above
 *   SET LOCAL ROLE              rejects *reads* of items.access_token_enc and
 *                               transactions.raw — a read-only transaction is
 *                               perfectly happy to select an encrypted token
 *   SET LOCAL statement_timeout stops an accidental cross join running forever
 *   LIMIT wrapper               stops a million rows landing in a context window
 *
 * The first two are the ones people conflate. Read-only is about writing;
 * the role is about reach. You need both.
 *
 * Every one of these uses SET **LOCAL** (and `SET TRANSACTION`, which is
 * inherently transaction-scoped). That is not stylistic. These connections come
 * from a pool of ten and go back into it: a plain `SET ROLE` would persist on
 * the connection, and the next caller to draw it — a sync, say — would find
 * itself demoted to a read-only role and fail somewhere unrelated. The test
 * suite proves the reversion.
 */

import { withTransaction, type DbRow } from "./client.js";

/** The role granted SELECT on the v_ views and nothing else. See schema.sql. */
const READ_ROLE = "costingly_ro";

/** Rows returned before truncating. A model has to read whatever comes back. */
const DEFAULT_ROW_CAP = 1000;

/** Generous for a personal database on a local socket; short enough to notice. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ReadOnlyOptions {
  /** Values for $1, $2, ... Numbering is unaffected by the LIMIT wrapper. */
  params?: readonly unknown[];
  rowCap?: number;
  timeoutMs?: number;
}

export interface ReadOnlyResult {
  rows: DbRow[];
  /** Column names in select order. Correct even when `rows` is empty. */
  columns: string[];
  /** True when more rows matched than the cap, and the rest were dropped. */
  truncated: boolean;
  /** The cap that applied, so a caller can say "first 1000 of more". */
  rowCap: number;
}

/**
 * Run a SELECT under every guard above and return its rows.
 *
 * Throws on invalid SQL, on a permission denial, and on timeout. That is
 * deliberate: this is a database function, and deciding that a failure should
 * be shown to a model rather than raised is a protocol-layer decision. The MCP
 * tool catches these and converts them; nothing here knows MCP exists.
 */
export async function queryReadOnly(
  sql: string,
  options: ReadOnlyOptions = {},
): Promise<ReadOnlyResult> {
  const rowCap = Math.max(1, Math.floor(options.rowCap ?? DEFAULT_ROW_CAP));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  // Trailing semicolons are what a person naturally types and would otherwise
  // make the wrapper a syntax error. Stripping them opens no door: an *interior*
  // semicolon still lands inside the subquery, where it is invalid — which is
  // how `SELECT 1; DROP TABLE items` gets rejected without being parsed.
  const inner = sql.trim().replace(/;+\s*$/, "");
  if (inner === "") throw new Error("No SQL to run.");

  // Fetch one more than the cap. That extra row is the only honest way to tell
  // "exactly 1000 rows matched" from "we stopped at 1000".
  const wrapped = `SELECT * FROM (\n${inner}\n) AS _capped LIMIT ${rowCap + 1}`;

  return withTransaction(async (client) => {
    // Must precede any query in the transaction, so it goes first.
    await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL ROLE ${READ_ROLE}`);
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);

    const result = await client.query(wrapped, options.params);
    const truncated = result.rows.length > rowCap;

    return {
      rows: truncated ? result.rows.slice(0, rowCap) : result.rows,
      columns: result.columns,
      truncated,
      rowCap,
    };
  });
}
