/**
 * Wiping this profile.
 *
 * Two scopes, and the difference matters to the person about to confirm one:
 *
 *   removeAllItems   every bank link and everything beneath it. Re-linking is
 *                    required afterwards, in a browser, for each bank.
 *   resetSyncedData  the transactions only. Bank links survive, so the next
 *                    sync backfills full history with no re-authentication.
 *
 * Deleting one bank is the routine path and lives in unlink.service.ts.
 */

import { withTransaction } from "../../data/db/queries.js";
import * as items from "../../data/repositories/items.repository.js";
import * as accounts from "../../data/repositories/accounts.repository.js";
import * as transactions from "../../data/repositories/transactions.repository.js";
import { removeItem, type RemovalOutcome } from "./unlink.service.js";

export interface DataCounts {
  items: number;
  accounts: number;
  transactions: number;
}

/** How much data currently exists. Used to show stakes before confirming. */
export async function countData(): Promise<DataCounts> {
  const [itemCount, accountCount, transactionCount] = await Promise.all([
    items.countAll(),
    accounts.countAll(),
    transactions.countAll(),
  ]);
  return { items: itemCount, accounts: accountCount, transactions: transactionCount };
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
    // Listed before deleting, because afterwards there is nothing left to name.
    const existing = await items.listBasic();
    await items.deleteAll();
    return existing.map((row) => ({ ...row, revoked: false }));
  }

  const stored = await items.listAllItems();
  const outcomes: RemovalOutcome[] = [];
  for (const item of stored) {
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
    const deleted = await transactions.deleteAll(client);
    await items.clearCursors(client);
    return { transactions: deleted };
  });
}

