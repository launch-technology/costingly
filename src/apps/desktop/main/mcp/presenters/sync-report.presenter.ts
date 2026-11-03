/**
 * A sync, worded for a model: the report of a run, and the state of the sync
 * when there is no fresh run to report.
 *
 * THE REPORT IS WRITTEN SO THAT A MODEL *SUMMARISING IT* SURFACES FAILURES.
 * This is the design constraint that matters here, and it is not the obvious
 * one. The natural output is a tidy count — "synced 4 banks, 15 new
 * transactions" — with a failed count somewhere for the diligent. But the
 * caller is frequently about to write a spending report, and a model skimming
 * a successful-looking summary will not go hunting for a failure flag. It
 * will report confidently on partial data.
 *
 * So failures go FIRST, before any figure, with an explicit instruction to
 * mention them. The counts are the reward for reading past the warning. The
 * same reasoning applies to the two quiet states that look like success and
 * are not: a first-time backfill (numbers will be unusually large) and a bank
 * Plaid is still preparing (a small number here means "not finished", not
 * "nothing happened"). What those two states ARE is decided once, in
 * features/sync/sync-outcomes.ts, for this report and the Accounts screen
 * alike.
 *
 * Pure functions; every state is a table entry in
 * tests/desktop-sync-report-presenter.test.mts.
 */

import type { SyncSummary } from "../../../../../domain/services/banks/sync.types.js";
import { loginExpired, stillPreparing } from "../../features/sync/sync-outcomes.js";
import type { SyncState } from "../../features/sync/sync.service.js";

export const NO_BANKS =
  "No banks are linked to costingly, so there was nothing to sync.\n\n" +
  "This is a setup step, not an error. Connecting a bank happens on Plaid's " +
  "login page in the user's browser: call link_bank for the page's address, or " +
  "tell the user to press Link a bank in the Costingly app.";

export function formatSyncSummary(summary: SyncSummary): string {
  if (summary.itemsTotal === 0) return NO_BANKS;

  const lines: string[] = [];
  const failed = summary.results.filter((r) => !r.ok);

  if (failed.length > 0) {
    lines.push(
      `WARNING: ${failed.length} of ${summary.itemsTotal} bank(s) FAILED TO SYNC. ` +
        `Any totals below cover only the banks that succeeded, so this data is ` +
        `INCOMPLETE. Say so explicitly in whatever you report.`,
    );
    lines.push("");
    for (const r of failed) {
      lines.push(`  ${r.institutionName ?? r.itemId}: ${r.error ?? "unknown error"}`);
      if (loginExpired(r)) {
        lines.push("      this bank's login has expired; relink_bank repairs it, with the user signing in again");
      }
    }
    lines.push("");
  }

  const seconds = (summary.durationMs / 1000).toFixed(1);
  lines.push(`Synced ${summary.itemsSucceeded} of ${summary.itemsTotal} bank(s) in ${seconds}s.`);
  lines.push("");

  for (const r of summary.results.filter((r) => r.ok)) {
    const changes: string[] = [];
    if (r.added > 0) changes.push(`+${r.added} added`);
    if (r.modified > 0) changes.push(`~${r.modified} updated`);
    if (r.removed > 0) changes.push(`-${r.removed} removed`);

    lines.push(`  ${r.institutionName ?? r.itemId}: ${changes.join(", ") || "no changes"}`);

    if (r.initialBackfill) {
      lines.push("      first sync for this bank — this was a full history backfill");
    }
    if (stillPreparing(r)) {
      lines.push(
        "      Plaid is still preparing this bank's history — more transactions " +
          "are expected. Sync again shortly.",
      );
    }
  }

  lines.push("");
  lines.push(`Totals: ${summary.added} added, ${summary.modified} modified, ${summary.removed} removed.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The state of the sync, when there is no fresh run to report
// ---------------------------------------------------------------------------

export const NO_SYNC_YET =
  "No sync has run since Costingly started. Nothing is wrong: call sync to run one, or " +
  "the user presses Sync in the app.";

/** `sync` found a run already in progress and started nothing. */
export function alreadyRunning(startedAt: Date, now: Date): string {
  return (
    `A sync is already running — it started ${ago(startedAt, now)}. Nothing new was started; ` +
    "there is only ever one at a time. Call sync_status to see how it ends, or sync again later."
  );
}

/** `sync` started a run and it had not finished when the wait ran out. */
export function stillRunning(startedAt: Date, now: Date): string {
  return (
    `The sync is running — it started ${ago(startedAt, now)} and has not finished yet. ` +
    "A first sync of a newly linked bank can take several minutes. Call sync_status to " +
    "see how it ends; do not call sync again meanwhile, it would only report that this one is running."
  );
}

/** `sync` started a run and nothing in it could run at all. */
export function runFailed(reason: string): string {
  return (
    `The sync could not run: ${reason}\n\n` +
    "Call check_costingly to see what is wrong before trying again."
  );
}

/** `sync` could not start because a bank is being unlinked right now. */
export const UNLINK_IN_PROGRESS =
  "The sync could not start: a bank is being unlinked, and the two never run at the " +
  "same time. Try again in a moment.";

/** What sync_status says. */
export function formatSyncStatus(state: SyncState, now: Date): string {
  switch (state.phase) {
    case "idle":
      return NO_SYNC_YET;
    case "running":
      return `A sync is running — it started ${ago(state.startedAt, now)}${by(state.trigger)}. Call sync_status again to see how it ends.`;
    case "failed":
      return `The latest sync could not run${by(state.trigger)}: ${state.reason}`;
    case "finished":
      return (
        `The latest sync${by(state.trigger)} started ${state.summary.startedAt} and finished ${state.summary.finishedAt}.\n\n` +
        formatSyncSummary(state.summary)
      );
  }
}

function by(trigger: "manual" | "mcp"): string {
  return trigger === "mcp" ? ", started through this endpoint" : ", started from the app";
}

/** "12 seconds ago", "3 minutes ago". */
function ago(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}
