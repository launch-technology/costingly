/**
 * `costingly sync` — the recurring sync.
 *
 * All it does is call `syncAllItems()` and render the summary. Keeping the
 * logic in `src/plaid/sync.ts` is what makes the two paths genuinely identical.
 *
 * Exit code is 1 if any item failed, so a caller can detect it.
 */

import type { Command } from "commander";
import { TransactionsUpdateStatus } from "plaid";
import { syncAllItems } from "../../../services/banks/sync.js";
import type { ItemSyncResult } from "../../../services/banks/sync.js";
import { CliError } from "../errors.js";

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

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Fetch new transactions from every linked bank (idempotent)")
    .helpGroup("Every day:")
    .addHelpText(
      "after",
      `
Exits non-zero if any bank failed.
Re-running is safe: a run with nothing to do writes nothing.`,
    )
    .action(async () => {
      try {
        await runSync();
      } catch (error) {
        // syncAllItems() absorbs per-item failures, so reaching here means
        // something global broke — an unreachable database, missing config, and so on.
        throw new CliError(
          `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

export async function runSync(): Promise<void> {
  const summary = await syncAllItems();

  if (summary.itemsTotal === 0) {
    console.log("No linked items to sync. Run `costingly link` to connect a bank.");
    return;
  }

  console.log(`Costingly sync — ${summary.startedAt}`);
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
