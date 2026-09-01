/**
 * Disconnecting one bank.
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
 * Revoking is opt-in, and a revoke failure never blocks the local delete —
 * otherwise a dead Plaid credential could wedge the database forever.
 *
 * Wiping everything at once is a different operation with a different blast
 * radius. See reset.service.ts.
 */

import type { ItemRemoveRequest } from "plaid";
import { db } from "../../data/db/data-source-registry.js";
import * as items from "../../data/repositories/items.repository.js";
import * as accounts from "../../data/repositories/accounts.repository.js";
import * as transactions from "../../data/repositories/transactions.repository.js";
import type { StoredItem } from "../../data/repositories/items.repository.js";
import { getPlaidClient, describeError } from "../../data/plaid.client.js";

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
    accounts.countForItem(db, itemId),
    transactions.countForItem(db, itemId),
  ]);
  return { accounts: accountCount, transactions: transactionCount };
}

/**
 * Invalidate an access_token at Plaid via /item/remove.
 *
 * Irreversible. After this the token is dead even if the row survives locally.
 */
async function revokeAtPlaid(accessToken: string): Promise<void> {
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
    const stored = await items.getItem(db, itemId);
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

  await items.deleteItem(db, item.itemId);
  return outcome;
}
