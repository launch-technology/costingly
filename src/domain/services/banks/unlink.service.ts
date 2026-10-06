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
 * ONE WAY TO UNLINK, FOR EVERY INTERFACE: `unlinkBank`.
 *
 * REVOKE FIRST, AND IF THAT FAILS, DELETE NOTHING. The access token lives in
 * the row. Delete the row after a revoke that did not happen and the Item is
 * still alive at Plaid, still billing, and the one credential that could have
 * removed it is gone — fixable only by hand in Plaid's dashboard. So a failed
 * revoke stops the unlink and says why, with everything still in place to try
 * again. Someone who wants the local data gone regardless asks for exactly
 * that: an unlink without the revoke, which never talks to Plaid.
 *
 * Wiping everything at once is a different operation with a different blast
 * radius, and a different answer to a failed revoke. See reset.service.ts.
 */

import type { ItemRemoveRequest } from "plaid";

import { db } from "../../data/default-database.js";
import * as items from "../../data/repositories/items.repository.js";
import * as accounts from "../../data/repositories/accounts.repository.js";
import * as transactions from "../../data/repositories/transactions.repository.js";
import { describeError, type PlaidClient } from "../../data/plaid.client.js";

/**
 * How much data one Item holds.
 *
 * Every interface asks this before destroying a bank. Counted before anything
 * is deleted, because afterwards there is nothing left to count and the user
 * deserves to be told what went.
 */
export async function countItemData(itemId: string): Promise<{ accounts: number; transactions: number }> {
  const [accountCount, transactionCount] = await Promise.all([
    accounts.countForItem(db, itemId),
    transactions.countForItem(db, itemId),
  ]);
  return { accounts: accountCount, transactions: transactionCount };
}

/** A bank, as much as is needed to ask "are you sure?" about it. */
export interface BankToUnlink {
  itemId: string;
  institutionName: string | null;
  /** False for sample data, which has no Plaid Item behind it and nothing to revoke. */
  atPlaid: boolean;
  accounts: number;
  transactions: number;
}

/**
 * Describe one bank before unlinking it, or null if no bank has that id.
 *
 * Reads no access token: a token that no longer decrypts must not make a bank
 * impossible to look at, which is the first step to removing it.
 */
export async function describeBank(itemId: string): Promise<BankToUnlink | null> {
  const { rows } = await db.query<{ institution_name: string | null; source: string }>(
    `SELECT institution_name, source FROM items WHERE item_id = $1`,
    [itemId],
  );
  const bank = rows[0];
  if (bank === undefined) return null;

  const counts = await countItemData(itemId);
  return {
    itemId,
    institutionName: bank.institution_name,
    atPlaid: bank.source === "plaid",
    ...counts,
  };
}

/**
 * Invalidate an access_token at Plaid via /item/remove.
 *
 * Irreversible. After this the token is dead even if the row survives locally.
 */
async function revokeAtPlaid(plaid: PlaidClient, accessToken: string): Promise<void> {
  const request: ItemRemoveRequest = { access_token: accessToken };
  await plaid.api.itemRemove(request);
}

/**
 * Revoke an Item's token at Plaid, tolerating every way that can fail.
 *
 * Reading the token can fail independently of anything else — a rotated or lost
 * encryption key — and so can Plaid itself. Both come back as a description
 * rather than a throw, so the caller decides what a failure means.
 *
 * A seeded bank has no token and no Plaid Item, so there is nothing to revoke.
 * That is reported as `attempted: false`, which is a different outcome from a
 * revoke that was tried and failed.
 */
export async function revokeIfPossible(
  plaid: PlaidClient,
  itemId: string,
): Promise<{ attempted: boolean; revoked: boolean; error?: string }> {
  try {
    const stored = await items.getItem(db, itemId);
    if (stored === null || stored.accessToken === null) {
      return { attempted: false, revoked: false };
    }

    await revokeAtPlaid(plaid, stored.accessToken);
    return { attempted: true, revoked: true };
  } catch (error) {
    return { attempted: true, revoked: false, error: describeError(error) };
  }
}

/** One bank removed during a wipe. See reset.service.ts. */
export interface RemovalOutcome {
  itemId: string;
  institutionName: string | null;
  /** True if the token was successfully invalidated at Plaid. */
  revoked: boolean;
  /** Set when revocation was attempted and failed; the local delete still ran. */
  revokeError?: string;
}

export type UnlinkOutcome =
  /** The bank and everything under it are gone from this database. */
  | { outcome: "unlinked"; institutionName: string | null; revokedAtPlaid: boolean }
  /** Plaid would not remove it — or its token could not be read. NOTHING was deleted. */
  | { outcome: "plaid-failed"; institutionName: string | null; reason: string }
  /** No bank has that id. */
  | { outcome: "not-found" };

/**
 * Unlink one bank.
 *
 * With `revokeAtPlaid`, the Item is removed at Plaid first, and only if that
 * works is anything deleted here. Without it, Plaid is never contacted and the
 * local data is simply deleted — the Item stays alive at Plaid.
 *
 * Accounts and transactions go with the bank: both foreign keys are ON DELETE
 * CASCADE. See migrations/0001-initial.sql.
 */
export async function unlinkBank(
  plaid: PlaidClient,
  itemId: string,
  options: { revokeAtPlaid: boolean },
): Promise<UnlinkOutcome> {
  // Found without decrypting anything: one unreadable token must not make a
  // bank impossible to name, or to remove locally.
  const known = await items.listBasic(db);
  const bank = known.find((row) => row.itemId === itemId);
  if (bank === undefined) return { outcome: "not-found" };

  let revokedAtPlaid = false;
  if (options.revokeAtPlaid) {
    const revocation = await revokeIfPossible(plaid, itemId);
    if (revocation.error !== undefined) {
      return { outcome: "plaid-failed", institutionName: bank.institutionName, reason: revocation.error };
    }
    revokedAtPlaid = revocation.revoked;
  }

  await items.deleteItem(db, itemId);
  return { outcome: "unlinked", institutionName: bank.institutionName, revokedAtPlaid };
}
