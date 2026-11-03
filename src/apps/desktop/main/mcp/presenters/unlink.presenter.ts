/**
 * Unlinking a bank, worded for a model: the preview that deletes nothing, the
 * result that did, and every way the request can be turned down.
 *
 * Counts come from the preview, taken before anything is destroyed, because
 * afterwards there is nothing left to count and the user deserves to be told
 * what went.
 */

import type { BankToUnlink, UnlinkOutcome } from "../../../../../domain/services/banks/unlink.service.js";

/** Phase one: what would go, and the token that lets phase two go ahead. */
export function unlinkPreview(bank: BankToUnlink, token: string): string {
  const name = bank.institutionName ?? bank.itemId;
  return [
    "NOTHING HAS BEEN DELETED YET.",
    "",
    `Disconnecting ${name} would permanently destroy:`,
    `  ${bank.accounts} account(s)`,
    `  ${bank.transactions} transaction(s)`,
    bank.atPlaid
      ? "  the stored connection, which is also ended at Plaid"
      : "  the stored connection (sample data: nothing at Plaid to end)",
    "",
    "Put those numbers to the user and wait for them to agree. Then call",
    "unlink_bank again with the same item_id and:",
    "",
    `  confirmation_token: ${token}`,
    "",
    "The token works once, only for this bank, and expires in five minutes.",
    "If the user says no, or does not answer, let it expire — there is",
    "nothing to undo.",
  ].join("\n");
}

/** Phase two went through. */
export function unlinkDone(bank: BankToUnlink, outcome: Extract<UnlinkOutcome, { outcome: "unlinked" }>): string {
  const name = bank.institutionName ?? bank.itemId;
  return [
    `Disconnected ${name} and deleted its data:`,
    `  ${bank.accounts} account(s)`,
    `  ${bank.transactions} transaction(s)`,
    "",
    outcome.revokedAtPlaid ? "The connection was also ended at Plaid." : "This bank had no Plaid connection to end.",
  ].join("\n");
}

export function plaidRefused(bank: BankToUnlink, reason: string): string {
  const name = bank.institutionName ?? bank.itemId;
  return (
    `${name} was NOT disconnected. Ending its connection at Plaid failed: ${reason}\n\n` +
    "Nothing was deleted, so this can be tried again. The preview's token was spent; " +
    "call unlink_bank with item_id alone for a fresh one."
  );
}

export const BAD_TOKEN =
  "That confirmation token is not valid for this bank, so nothing was deleted. Tokens " +
  "are single-use, last five minutes, and belong to the one item_id they were issued " +
  "for.\n\nCall unlink_bank with item_id alone to see what would be deleted and get a " +
  "fresh token.";

export const SYNC_IN_PROGRESS =
  "Nothing was deleted: a sync is running, and a bank is never unlinked while one is. " +
  "Call sync_status to see when it finishes, then try again.";

export const NO_BANKS_TO_UNLINK = "No banks are connected, so there is nothing to disconnect.";

export function unlinkFailed(reason: string): string {
  return `The bank could not be unlinked: ${reason}\n\nNothing was deleted. Call check_costingly to see what is wrong.`;
}
