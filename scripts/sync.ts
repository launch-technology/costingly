/**
 * CLI entrypoint for the recurring sync.  Usage:  npm run sync
 *
 * This is what a cron job runs. All it does is call `syncAllItems()` — the same
 * function the Vercel cron route calls — and render the summary. Keeping the
 * logic in `src/sync.ts` is what makes the two paths genuinely identical.
 *
 * Exit code is 1 if any item failed, so cron/monitoring can alert on it.
 */

import "dotenv/config";
import { TransactionsUpdateStatus } from "plaid";
import { syncAllItems } from "../src/sync.js";
import { closePool } from "../src/db.js";
import type { ItemSyncResult } from "../src/sync.js";

function label(result: ItemSyncResult): string {
  return result.institutionName ?? result.itemId;
}

function describeItem(result: ItemSyncResult): string {
  if (!result.ok) {
    return `  FAIL  ${label(result)}\n          ${result.error ?? "unknown error"}`;
  }

  const parts = [
    `+${result.added} added`,
    `~${result.modified} modified`,
    `-${result.removed} removed`,
    `${result.accounts} account(s)`,
  ];

  const notes: string[] = [];
  if (result.initialBackfill) notes.push("initial backfill");
  if (result.pages > 1) notes.push(`${result.pages} pages`);
  // NOT_READY means Plaid is still pulling this Item's history in the
  // background; the next run picks up the rest.
  if (result.updateStatus === TransactionsUpdateStatus.NotReady) {
    notes.push("Plaid still preparing history — run sync again shortly");
  }

  const suffix = notes.length > 0 ? `  (${notes.join("; ")})` : "";
  return `  ok    ${label(result)}: ${parts.join(", ")}${suffix}`;
}

async function main(): Promise<void> {
  const summary = await syncAllItems();

  if (summary.itemsTotal === 0) {
    console.log("No linked items to sync. Run `npm run link` to connect a bank.");
    return;
  }

  console.log(`Plaid sync — ${summary.startedAt}`);
  for (const result of summary.results) {
    console.log(describeItem(result));
  }

  console.log(
    `\n${summary.itemsSucceeded}/${summary.itemsTotal} item(s) synced in ` +
      `${(summary.durationMs / 1000).toFixed(1)}s — ` +
      `+${summary.added} added, ~${summary.modified} modified, -${summary.removed} removed`,
  );

  if (!summary.ok) {
    console.error(`\n${summary.itemsFailed} item(s) failed.`);
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    // syncAllItems() absorbs per-item failures, so reaching here means
    // something global broke — bad DATABASE_URL, missing env, and so on.
    console.error("Sync failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
