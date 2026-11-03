/**
 * Two things a bank's sync result can mean that are not written on its face,
 * read in one place so the Accounts screen and the sync report a model gets
 * agree about them.
 *
 *   STILL PREPARING. A newly linked bank often comes back with few or no
 *   transactions the first time, because Plaid is still collecting its
 *   history. Reported as a bare count it reads as "this bank has no
 *   transactions", which is false.
 *
 *   LOGIN EXPIRED. The one failure a person fixes with a button rather than
 *   by trying again: the bank wants a fresh sign-in.
 */

import type { ItemSyncResult } from "../../../../../domain/services/banks/sync.types.js";

/** Plaid's status for a history it has not finished collecting. */
export function stillPreparing(result: ItemSyncResult): boolean {
  return String(result.updateStatus ?? "").toUpperCase().includes("NOT_READY");
}

/**
 * Plaid's code for a login the user must renew. The domain describes a Plaid
 * error as `TYPE/CODE: message`, and the code is Plaid's own fixed identifier
 * — this matches that, not the wording after it.
 */
export function loginExpired(result: ItemSyncResult): boolean {
  return /\bITEM_LOGIN_REQUIRED\b/.test(result.error ?? "");
}
