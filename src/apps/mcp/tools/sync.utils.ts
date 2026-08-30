import type { SyncSummary } from "../../../services/banks/sync.js";

/**
 * A sync summary, written so that a model *summarising it* surfaces failures.
 *
 * This is the design constraint that matters here, and it is not the obvious
 * one. The natural output is a tidy count — "synced 4 banks, 15 new
 * transactions" — with an `itemsFailed` field somewhere for the diligent. But
 * the caller is frequently an unattended scheduled task about to write a
 * spending report, and a model skimming a successful-looking summary will not
 * go hunting for a failure flag. It will report confidently on partial data.
 *
 * So failures go FIRST, before any figure, with an explicit instruction to
 * mention them. The counts are the reward for reading past the warning.
 *
 * The same reasoning applies to the two quiet states that look like success and
 * are not: a first-time backfill (numbers will be unusually large) and Plaid's
 * NOT_READY (the bank's history is still being prepared, so a small number here
 * means "not finished", not "nothing happened").
 */
export function formatSyncSummary(summary: SyncSummary): string {
  if (summary.itemsTotal === 0) {
    return (
      "No banks are linked to costingly, so there was nothing to sync.\n\n" +
      "This is a setup step, not an error. Connecting a bank requires Plaid's " +
      "hosted login page in a browser and cannot be done from here — tell the " +
      "user to run `costingly link`."
    );
  }

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
    // Plaid returns NOT_READY while it is still assembling an Item's history.
    // Small numbers here mean "not finished yet", which reads exactly like
    // "nothing to do" unless it is spelled out.
    if (String(r.updateStatus ?? "").toUpperCase().includes("NOT_READY")) {
      lines.push(
        "      Plaid is still preparing this bank's history — more transactions " +
          "are expected. Sync again shortly.",
      );
    }
  }

  lines.push("");
  lines.push(
    `Totals: ${summary.added} added, ${summary.modified} modified, ${summary.removed} removed.`,
  );

  return lines.join("\n");
}
