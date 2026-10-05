/**
 * A sync, worded for the Accounts screen.
 *
 * Pure functions, like the other presenters; every case is a table entry in
 * tests/desktop-sync-presenter.test.mts.
 *
 * The domain's summary is written for a terminal and a model: counts, Plaid's
 * status words, an error string per bank. This says the same facts the way a
 * window should:
 *
 *   NOTHING NEW IS "UP TO DATE", NOT "0 ADDED".
 *
 *   A HISTORY PLAID IS STILL PREPARING IS SAID AS THAT. A newly linked bank
 *   often comes back with few or no transactions the first time, because
 *   Plaid is still collecting them. Reported as a bare count it reads as "this
 *   bank has no transactions", which is false and alarming.
 *
 *   AN EXPIRED LOGIN IS NOT AN ERROR MESSAGE. It is a thing the user fixes
 *   with a button, so it is said as what to do.
 *
 *   A FAILURE EVERY BANK SHARES IS SAID ONCE. No network fails every bank
 *   with the same sentence; repeated on each of them it reads as that many
 *   problems.
 */

import type { ItemSyncResult, SyncSummary } from "../../../../domain/services/banks/sync.types.js";
import type { BankSyncResult, Problem, SyncView } from "../../bridge/contract.js";
import type { SyncState } from "../services/sync.service.js";

export function presentSync(state: SyncState): SyncView {
  switch (state.phase) {
    case "idle":
      return { state: "idle" };
    case "running":
      return { state: "running" };
    case "failed":
      return {
        state: "finished",
        tone: "bad",
        summary: "The sync could not run.",
        problem: {
          cause: `The sync could not run: ${state.reason}`,
          nextStep: "Check the Database section on the Status screen, then sync again.",
        },
        results: [],
      };
    case "finished":
      return presentSummary(state.summary);
  }
}

function presentSummary(summary: SyncSummary): SyncView {
  const { results } = summary;

  if (results.length === 0) {
    return {
      state: "finished",
      tone: "neutral",
      summary: "There was no bank to sync. A bank that needs attention is skipped until it is reconnected.",
      results: [],
    };
  }

  const shared = sharedFailure(results);
  if (shared !== undefined) {
    return {
      state: "finished",
      tone: "bad",
      summary: results.length === 1 ? "The bank was not synced." : "No bank was synced.",
      problem: shared,
      results: results.map((result) => ({ bankId: result.itemId, tone: "bad", text: "Not synced." })),
    };
  }

  const failed = results.filter((result) => !result.ok).length;
  return {
    state: "finished",
    tone: failed === 0 ? "good" : "warn",
    summary:
      failed === 0
        ? `Synced ${banks(results.length)}.`
        : `Synced ${results.length - failed} of ${banks(results.length)}. ${failed} could not be synced.`,
    results: results.map(presentResult),
  };
}

function banks(count: number): string {
  return count === 1 ? "1 bank" : `${count} banks`;
}

function presentResult(result: ItemSyncResult): BankSyncResult {
  const bankId = result.itemId;

  if (!result.ok) {
    return loginExpired(result)
      ? {
          bankId,
          tone: "warn",
          text: "Your bank login has expired, so this bank was not synced. Reconnect it, then sync again.",
        }
      : { bankId, tone: "bad", text: `Could not sync: ${result.error ?? "no reason was given"}` };
  }

  const counted = changes(result);
  if (historyNotReady(result)) {
    return {
      bankId,
      tone: "warn",
      text:
        (counted === "" ? "" : `${counted} so far. `) +
        "This bank is still preparing its history. Sync again in a few minutes.",
    };
  }

  return { bankId, tone: "good", text: counted === "" ? "Up to date." : `${counted}.` };
}

/** "12 new, 3 updated, 1 removed" — only the parts that are not zero. */
function changes(result: ItemSyncResult): string {
  const parts: string[] = [];
  if (result.added > 0) parts.push(`${count(result.added)} new`);
  if (result.modified > 0) parts.push(`${count(result.modified)} updated`);
  if (result.removed > 0) parts.push(`${count(result.removed)} removed`);
  return parts.join(", ");
}

function count(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/** Plaid's status for a history it has not finished collecting. */
function historyNotReady(result: ItemSyncResult): boolean {
  return String(result.updateStatus ?? "").toUpperCase().includes("NOT_READY");
}

/**
 * Plaid's code for a login the user must renew. The domain describes a Plaid
 * error as `TYPE/CODE: message`, and the code is Plaid's own fixed identifier
 * — this matches that, not the wording after it.
 */
function loginExpired(result: ItemSyncResult): boolean {
  return /\bITEM_LOGIN_REQUIRED\b/.test(result.error ?? "");
}

/**
 * The one reason every bank failed for, if there is one.
 *
 * An expired login is never "shared", even with a single bank: it is that
 * bank's own problem, with its own button.
 */
function sharedFailure(results: ItemSyncResult[]): Problem | undefined {
  const first = results[0];
  if (first === undefined || results.some((result) => result.ok || loginExpired(result))) return undefined;
  if (results.some((result) => result.error !== first.error)) return undefined;

  // Said neutrally: the usual cause is no network or keys Plaid refuses, but a
  // database stopped part-way fails every remaining bank the same way too.
  return {
    cause: `No bank could be synced: ${first.error ?? "no reason was given"}`,
    nextStep: "Check your internet connection and the Status screen, then sync again.",
  };
}
