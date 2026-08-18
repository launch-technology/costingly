/**
 * Destructive operations: unlinking a bank and wiping local data.
 *
 * Two distinct things happen when you "remove a bank", and conflating them is
 * how people end up paying for Items they thought were gone:
 *
 *   local delete  — drops rows from this database. Cheap, reversible by
 *                   re-linking. The Plaid Item keeps existing and keeps
 *                   counting against your plan.
 *   revoke        — calls Plaid's /item/remove. Permanently invalidates the
 *                   access_token at Plaid and stops the billing. Cannot be
 *                   undone; the user must go through Link again.
 *
 * `revoke` is opt-in throughout, and a revoke failure never blocks the local
 * delete — otherwise a dead Plaid credential could wedge the database forever.
 */

import type { ItemRemoveRequest } from "plaid";
import { query, withTransaction } from "../db/client.js";
import { listAllItems, type StoredItem } from "./items.js";
import { getPlaidClient, describeError } from "./client.js";

export interface DataCounts {
  items: number;
  accounts: number;
  transactions: number;
}

/** How much data currently exists. Used to show stakes before confirming. */
export async function countData(): Promise<DataCounts> {
  const { rows } = await query<{ items: string; accounts: string; transactions: string }>(
    `SELECT (SELECT COUNT(*) FROM items)::text        AS items,
            (SELECT COUNT(*) FROM accounts)::text     AS accounts,
            (SELECT COUNT(*) FROM transactions)::text AS transactions`,
  );
  const row = rows[0];
  return {
    items: Number(row?.items ?? 0),
    accounts: Number(row?.accounts ?? 0),
    transactions: Number(row?.transactions ?? 0),
  };
}

/**
 * Invalidate an access_token at Plaid via /item/remove.
 *
 * Irreversible. After this the token is dead even if the row survives locally.
 */
export async function revokeAtPlaid(accessToken: string): Promise<void> {
  const request: ItemRemoveRequest = { access_token: accessToken };
  await getPlaidClient().itemRemove(request);
}

export interface RemovalOutcome {
  itemId: string;
  institutionName: string | null;
  /** True if the token was successfully invalidated at Plaid. */
  revoked: boolean;
  /** Set when revocation was attempted and failed; the local delete still ran. */
  revokeError?: string;
}

/**
 * Delete one Item locally, optionally revoking it at Plaid first.
 *
 * Accounts and transactions disappear via ON DELETE CASCADE.
 */
export async function removeItem(
  item: StoredItem,
  options: { revoke: boolean },
): Promise<RemovalOutcome> {
  const outcome: RemovalOutcome = {
    itemId: item.itemId,
    institutionName: item.institutionName,
    revoked: false,
  };

  // Nothing to revoke for an Item that was never a bank login. Seeded data is
  // deleted exactly like anything else — it just skips the Plaid call, so
  // `unlink` needs no branch of its own and the model needs no second tool.
  if (options.revoke && item.accessToken !== null) {
    try {
      await revokeAtPlaid(item.accessToken);
      outcome.revoked = true;
    } catch (error) {
      // Deliberately non-fatal: the user asked for this row to go away, and
      // refusing would leave them stuck. Surfaced so they can clean up in the
      // Plaid dashboard.
      outcome.revokeError = describeError(error);
    }
  }

  await query(`DELETE FROM items WHERE item_id = $1`, [item.itemId]);
  return outcome;
}

/**
 * Delete every Item and all data beneath it.
 *
 * When `revoke` is false no access token is ever decrypted, so this still works
 * if ENCRYPTION_KEY has been lost or rotated — which is precisely one of the
 * reasons you would want to wipe and start over.
 */
export async function removeAllItems(options: {
  revoke: boolean;
}): Promise<RemovalOutcome[]> {
  if (!options.revoke) {
    const { rows } = await query<{ item_id: string; institution_name: string | null }>(
      `SELECT item_id, institution_name FROM items`,
    );
    // TRUNCATE would be faster, but DELETE keeps the cascade semantics obvious
    // and this is never a hot path.
    await query(`DELETE FROM items`);
    return rows.map((row) => ({
      itemId: row.item_id,
      institutionName: row.institution_name,
      revoked: false,
    }));
  }

  const items = await listAllItems();
  const outcomes: RemovalOutcome[] = [];
  for (const item of items) {
    outcomes.push(await removeItem(item, { revoke: true }));
  }
  return outcomes;
}

/**
 * Keep the bank links, throw away the synced data.
 *
 * Deletes every transaction and clears each Item's cursor, so the next
 * `costingly sync` performs a fresh full-history backfill. Useful for rebuilding
 * after a schema change without making the user re-authenticate anywhere.
 *
 * Done in one transaction: leaving cursors intact after dropping the rows they
 * describe would make the missing history unrecoverable without a re-link.
 */
export async function resetSyncedData(): Promise<{ transactions: number }> {
  return withTransaction(async (client) => {
    const deleted = await client.query(`DELETE FROM transactions`);
    await client.query(
      `UPDATE items SET cursor = NULL, last_synced_at = NULL, updated_at = now()`,
    );
    return { transactions: deleted.rowCount ?? 0 };
  });
}
