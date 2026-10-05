/**
 * The transactions table.
 *
 * Two things write here — a Plaid sync and the seed generator — and before this
 * existed they each carried their own INSERT, with their own column list and
 * their own batching. Two answers to one question, and only one of them had to
 * be right for the other to look fine.
 *
 * So the SQL lives here and callers hand over rows. Mapping a provider's shape
 * into `TransactionRow` stays with whoever knows that provider: Plaid's field
 * names are the sync service's business, not this file's.
 *
 * SIGN CONVENTION
 *
 * `amount` is stored exactly as Plaid reports it — positive is money OUT,
 * negative is money IN. Every reader depends on that, and the column comment in
 * the schema is what tells a model about it.
 */

import type { Executor } from "../../../platform/postgres/types/executor.js";

/** Columns in insert order. `transaction_id` is the conflict target. */
const COLUMNS = [
  "transaction_id",
  "account_id",
  "item_id",
  "amount",
  "iso_currency_code",
  "date",
  "authorized_date",
  "name",
  "merchant_name",
  "pending",
  "payment_channel",
  "category",
  "pfc",
  "raw",
] as const;

/**
 * Rows per statement.
 *
 * A couple of thousand single-row round trips is slow enough to notice on a
 * command someone is waiting for, and Postgres caps a statement at 65535 bound
 * parameters — 200 rows of 14 columns is 2,800, comfortably inside it.
 */
const CHUNK_SIZE = 200;

/** One transaction as the table stores it. JSON columns arrive pre-encoded. */
export interface TransactionRow {
  transactionId: string;
  accountId: string;
  itemId: string;
  amount: number;
  isoCurrencyCode: string | null;
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  pending: boolean;
  paymentChannel: string | null;
  /** Plaid's legacy category array, JSON-encoded. Null where there is none. */
  category: string | null;
  /** personal_finance_category, JSON-encoded. */
  pfc: string | null;
  /** The provider payload the row was built from, JSON-encoded. */
  raw: string;
}

function values(row: TransactionRow): unknown[] {
  return [
    row.transactionId,
    row.accountId,
    row.itemId,
    row.amount,
    row.isoCurrencyCode,
    row.date,
    row.authorizedDate,
    row.name,
    row.merchantName,
    row.pending,
    row.paymentChannel,
    row.category,
    row.pfc,
    row.raw,
  ];
}

/**
 * Insert or update, in chunked multi-row statements.
 *
 * The input must already be de-duplicated by `transactionId`: Postgres rejects
 * an ON CONFLICT DO UPDATE that tries to touch the same row twice ("cannot
 * affect row a second time"), and a paginated sync can legitimately return the
 * same id on more than one page.
 *
 * `created_at` takes its column default on insert and is left alone on update,
 * so a row keeps the moment it first arrived.
 */
export async function upsertMany(
  exec: Executor,
  rows: readonly TransactionRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const columnList = COLUMNS.join(", ");
  const updateList = COLUMNS.filter((column) => column !== "transaction_id")
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(",\n        ");

  for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + CHUNK_SIZE);

    const params: unknown[] = [];
    const tuples: string[] = [];

    for (const row of chunk) {
      const rowValues = values(row);
      const placeholders = rowValues.map((_, index) => `$${params.length + index + 1}`);
      tuples.push(`(${placeholders.join(", ")}, now())`);
      params.push(...rowValues);
    }

    await exec.query(
      `
      INSERT INTO transactions (${columnList}, updated_at)
      VALUES ${tuples.join(", ")}
      ON CONFLICT (transaction_id) DO UPDATE SET
        ${updateList},
        updated_at = now()
      `,
      params,
    );
  }
}

/**
 * Delete by id, chunked to stay inside the parameter limit.
 *
 * The common case is a pending transaction settling: Plaid issues the settled
 * version under a brand-new id and retracts the pending one, so these deletes
 * are what stop the table accumulating stale pending rows.
 */
export async function deleteByIds(exec: Executor, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += CHUNK_SIZE) {
    const chunk = unique.slice(offset, offset + CHUNK_SIZE);
    await exec.query(`DELETE FROM transactions WHERE transaction_id = ANY($1::text[])`, [chunk]);
  }
}

/**
 * Delete every transaction. Returns how many went.
 *
 * The caller must pair this with clearing every item cursor, in one
 * transaction: dropping the rows while the cursors still point past them makes
 * the missing history unrecoverable without a re-link. See resetSyncedData().
 */
export async function deleteAll(exec: Executor): Promise<number> {
  const result = await exec.query(`DELETE FROM transactions`);
  return result.rowCount ?? 0;
}

/** How many transactions exist across every Item. */
export async function countAll(exec: Executor): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM transactions`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** How many transactions belong to one Item. */
export async function countForItem(exec: Executor, itemId: string): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM transactions WHERE item_id = $1`,
    [itemId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** A transaction as a person needs to see it, with its account for context. */
export interface TransactionListing {
  date: string;
  name: string;
  merchant_name: string | null;
  amount: string;
  pending: boolean;
  category: string | null;
  account_name: string | null;
  mask: string | null;
  currency: string | null;
}

/**
 * Transactions for a set of accounts, newest first.
 *
 * `cutoff` is an inclusive lower bound as a "YYYY-MM-DD" string, or null for no
 * bound. It is computed by the caller from the caller's own calendar rather
 * than from the database's, because a transaction date is a local calendar day
 * at the bank and the server's timezone is not that.
 */
export async function listForAccounts(
  exec: Executor,
  accountIds: readonly string[],
  cutoff: string | null,
): Promise<TransactionListing[]> {
  const { rows } = await exec.query<TransactionListing>(
    `
    SELECT t.date, t.name, t.merchant_name, t.amount, t.pending,
           t.pfc->>'primary' AS category,
           a.name            AS account_name,
           a.mask,
           a.currency
      FROM transactions t
      JOIN accounts a ON a.account_id = t.account_id
     WHERE t.account_id = ANY($1::text[])
       AND ($2::date IS NULL OR t.date >= $2::date)
     ORDER BY t.date DESC, t.pending DESC, t.transaction_id
    `,
    [accountIds, cutoff],
  );
  return rows;
}

/**
 * How much these accounts hold in total, and the most recent date present.
 *
 * Exists so an empty window can be told apart from an empty account. "No
 * results" and "nothing here at all" look identical otherwise, and only one of
 * them is worth suggesting a wider window for.
 */
export async function summaryForAccounts(
  exec: Executor,
  accountIds: readonly string[],
): Promise<{ newest: string | null; total: number }> {
  const { rows } = await exec.query<{ newest: string | null; total: string }>(
    `
    SELECT MAX(date)::text AS newest, COUNT(*)::text AS total
      FROM transactions
     WHERE account_id = ANY($1::text[])
    `,
    [accountIds],
  );
  return { newest: rows[0]?.newest ?? null, total: Number(rows[0]?.total ?? 0) };
}

/** What narrows a search. Every part is optional; with none, it is everything. */
export interface TransactionSearch {
  /** One account, or null for all of them. */
  accountId: string | null;
  /** Inclusive lower bound, "YYYY-MM-DD", or null. */
  from: string | null;
  /** Inclusive upper bound, "YYYY-MM-DD", or null. */
  to: string | null;
  /**
   * A LIKE pattern for the description and the merchant name, or null. The
   * caller builds it — wildcards placed, the user's own text escaped with
   * PATTERN_ESCAPE — because what counts as a match is the caller's decision,
   * not this file's.
   */
  pattern: string | null;
}

/** A transaction found by a search: enough to show it and to tell rows apart. */
export interface FoundTransaction {
  transaction_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: string;
  pending: boolean;
  category: string | null;
  account_id: string;
  account_name: string | null;
  mask: string | null;
  currency: string | null;
  institution_name: string | null;
}

/**
 * The character that makes the next one literal in a search pattern. Not the
 * usual backslash: that one means something to JavaScript strings, to SQL
 * strings and to LIKE all at once, and three layers of doubling is where a
 * search for "50%" quietly starts matching everything.
 */
export const PATTERN_ESCAPE = "!";

/** The WHERE both search queries share, so a count can never disagree with its rows. */
const SEARCH_WHERE = `
      ($1::text IS NULL OR t.account_id = $1)
  AND ($2::date IS NULL OR t.date >= $2::date)
  AND ($3::date IS NULL OR t.date <= $3::date)
  AND ($4::text IS NULL
       OR t.name ILIKE $4 ESCAPE '${PATTERN_ESCAPE}'
       OR t.merchant_name ILIKE $4 ESCAPE '${PATTERN_ESCAPE}')`;

function searchParams(search: TransactionSearch): unknown[] {
  return [search.accountId, search.from, search.to, search.pattern];
}

/**
 * The newest `limit` transactions matching a search.
 *
 * Newest first; on one day, pending before settled, as a bank shows them; the
 * id last, so the order is the same every time and a longer limit returns the
 * same rows followed by more.
 */
export async function search(
  exec: Executor,
  criteria: TransactionSearch,
  limit: number,
): Promise<FoundTransaction[]> {
  const { rows } = await exec.query<FoundTransaction>(
    `
    SELECT t.transaction_id, t.date::text AS date, t.name, t.merchant_name, t.amount, t.pending,
           t.pfc->>'primary' AS category,
           a.account_id,
           a.name            AS account_name,
           a.mask,
           COALESCE(t.iso_currency_code, a.currency) AS currency,
           i.institution_name
      FROM transactions t
      JOIN accounts a ON a.account_id = t.account_id
      JOIN items    i ON i.item_id    = t.item_id
     WHERE ${SEARCH_WHERE}
     ORDER BY t.date DESC, t.pending DESC, t.transaction_id
     LIMIT $5
    `,
    [...searchParams(criteria), limit],
  );
  return rows;
}

/** How many transactions match a search, whatever the limit. */
export async function countMatching(exec: Executor, criteria: TransactionSearch): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM transactions t WHERE ${SEARCH_WHERE}`,
    searchParams(criteria),
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * How many transactions there are in all, for one account or for every
 * account, and the newest date among them. What lets "nothing matches" be told
 * apart from "there is nothing here at all".
 */
export async function extent(
  exec: Executor,
  accountId: string | null,
): Promise<{ total: number; newest: string | null }> {
  const { rows } = await exec.query<{ total: string; newest: string | null }>(
    `SELECT COUNT(*)::text AS total, MAX(date)::text AS newest
       FROM transactions
      WHERE ($1::text IS NULL OR account_id = $1)`,
    [accountId],
  );
  return { total: Number(rows[0]?.total ?? 0), newest: rows[0]?.newest ?? null };
}
