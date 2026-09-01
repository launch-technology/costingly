/**
 * The accounts table.
 *
 * An account belongs to an Item and disappears with it — the foreign key is
 * ON DELETE CASCADE, so nothing here deletes accounts directly. What is left is
 * writing them and counting them.
 *
 * Balances are stored as reported and never recomputed. They are a snapshot
 * from the last sync, not a running total of the transactions below them, and a
 * reader that adds up transactions instead will get a different number for
 * good reasons.
 */

import type { Executor } from "../db/types/executor.js";

/** One account as the table stores it. */
export interface AccountRow {
  accountId: string;
  itemId: string;
  name: string | null;
  officialName: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  currentBalance: number | null;
  availableBalance: number | null;
}

/**
 * Insert or update, one statement per account.
 *
 * Deliberately not batched: an Item has a handful of accounts, never thousands,
 * so the multi-row machinery the transactions repository needs would be cost
 * without benefit here.
 */
export async function upsertMany(
  exec: Executor,
  rows: readonly AccountRow[],
): Promise<number> {
  for (const row of rows) {
    await exec.query(
      `
      INSERT INTO accounts (
        account_id, item_id, name, official_name, mask, type, subtype,
        currency, current_balance, available_balance, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (account_id) DO UPDATE SET
        item_id           = EXCLUDED.item_id,
        name              = EXCLUDED.name,
        official_name     = EXCLUDED.official_name,
        mask              = EXCLUDED.mask,
        type              = EXCLUDED.type,
        subtype           = EXCLUDED.subtype,
        currency          = EXCLUDED.currency,
        current_balance   = EXCLUDED.current_balance,
        available_balance = EXCLUDED.available_balance,
        updated_at        = now()
      `,
      [
        row.accountId,
        row.itemId,
        row.name,
        row.officialName,
        row.mask,
        row.type,
        row.subtype,
        row.currency,
        row.currentBalance,
        row.availableBalance,
      ],
    );
  }

  return rows.length;
}

/** How many accounts exist across every Item. */
export async function countAll(exec: Executor): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM accounts`);
  return Number(rows[0]?.count ?? 0);
}

/** How many accounts belong to one Item. */
export async function countForItem(exec: Executor, itemId: string): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM accounts WHERE item_id = $1`,
    [itemId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * An account as a person needs to see it: balance, bank name, and how many
 * transactions sit behind it. Column names stay snake_case because this is a
 * display row read straight out of the database, not a domain object.
 */
export interface AccountListing {
  account_id: string;
  name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  current_balance: string | null;
  institution_name: string | null;
  txn_count: string;
}

/**
 * Accounts matching a free-text term, or all of them when given null.
 *
 * The term is matched against the account id, its mask, its name and the bank's
 * name, so "chase", "0000" and a full account id all work without the caller
 * having to say which kind of thing it has.
 */
export async function search(exec: Executor, term: string | null): Promise<AccountListing[]> {
  const { rows } = await exec.query<AccountListing>(
    `
    SELECT a.account_id, a.name, a.mask, a.type, a.subtype, a.currency,
           a.current_balance, i.institution_name,
           COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.account_id), 0)::text
             AS txn_count
      FROM accounts a
      JOIN items i ON i.item_id = a.item_id
     WHERE $1::text IS NULL
        OR a.account_id = $1
        OR a.mask = $1
        OR a.name ILIKE '%' || $1 || '%'
        OR i.institution_name ILIKE '%' || $1 || '%'
     ORDER BY i.institution_name NULLS LAST, a.name NULLS LAST
    `,
    [term],
  );
  return rows;
}
