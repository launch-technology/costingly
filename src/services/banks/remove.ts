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
import { withTransaction } from "../../data/db/queries.js";
import * as items from "../../data/repositories/items.repository.js";
import * as accounts from "../../data/repositories/accounts.repository.js";
import * as transactions from "../../data/repositories/transactions.repository.js";
import type { StoredItem } from "../../data/repositories/items.repository.js";
import { getPlaidClient, describeError } from "../../data/plaid.client.js";

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
 * How much data one Item holds.
 *
 * Both interfaces ask this before destroying a bank, and both used to ask it
 * with their own copy of the same SQL. Counted before anything is deleted,
 * because afterwards there is nothing left to count and the user deserves to be
 * told what went.
 */
export async function countItemData(itemId: string): Promise<{ accounts: number; transactions: number }> {
  const [accountCount, transactionCount] = await Promise.all([
    accounts.countForItem(itemId),
    transactions.countForItem(itemId),
  ]);
  return { accounts: accountCount, transactions: transactionCount };
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

/**
 * Revoke an Item's token at Plaid, tolerating every way that can fail.
 *
 * Reading the token can fail independently of anything else — a rotated or lost
 * encryption key — and so can Plaid itself. Neither must leave a user unable to
 * delete the row, so both come back as a description rather than a throw.
 *
 * A seeded bank has no token and no Plaid Item, so there is nothing to revoke.
 * That is reported as `attempted: false`, which is a different outcome from a
 * revoke that was tried and failed.
 */
export async function revokeIfPossible(
  itemId: string,
): Promise<{ attempted: boolean; revoked: boolean; error?: string }> {
  try {
    const stored = await items.getItem(itemId);
    if (stored === null || stored.accessToken === null) {
      return { attempted: false, revoked: false };
    }
    await revokeAtPlaid(stored.accessToken);
    return { attempted: true, revoked: true };
  } catch (error) {
    return { attempted: true, revoked: false, error: describeError(error) };
  }
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

  await items.deleteItem(item.itemId);
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
