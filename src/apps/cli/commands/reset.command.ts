/**
 * `costingly reset` — wipe local data.  DESTRUCTIVE.
 *
 *   costingly reset               delete everything (banks, accounts, transactions)
 *   costingly reset --revoke      ...and invalidate the tokens at Plaid too
 *   costingly reset --data-only   keep the bank links, drop synced data
 *   costingly reset --yes         skip the confirmation (scripts only)
 *
 * Use it to start over: clear everything and re-link, or drop synced data while
 * keeping the bank connections.
 */

import type { Command } from "commander";
import { get } from "../../../core/config.js";
import { countData, removeAllItems, resetSyncedData } from "../../../services/banks/reset.service.js";
import type { RemovalOutcome } from "../../../services/banks/unlink.service.js";
import { confirmDestructive } from "../ui/confirm.js";

interface ResetOptions {
  dataOnly?: boolean;
  revoke?: boolean;
  yes?: boolean;
}

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Delete all local data")
    .helpGroup("Destructive — each asks you to type the environment name:")
    .option("--data-only", "keep the bank links; delete transactions and reset cursors")
    .option(
      "--revoke",
      "also call Plaid's /item/remove, permanently invalidating each access token",
    )
    .option("-y, --yes", "skip the confirmation prompt (for scripts)")
    .addHelpText(
      "after",
      `
Deleting locally does NOT remove the Item at Plaid — it keeps existing and keeps
counting against your plan. Use --revoke to invalidate it there as well.

Starting over:
  costingly reset --revoke     # clean slate, tokens invalidated at Plaid
  costingly link               # re-link each bank`,
    )
    .action(async (options: ResetOptions) => {
      await runReset(options);
    });
}

export async function runReset(options: ResetOptions): Promise<void> {
  if (options.dataOnly && options.revoke) {
    console.error(
      "--data-only and --revoke are contradictory: --data-only keeps the bank links,\n" +
        "so revoking their tokens would leave rows whose credentials are dead.",
    );
    process.exitCode = 1;
    return;
  }

  const counts = await countData();

  if (counts.items === 0 && counts.transactions === 0) {
    console.log("Nothing to delete — the database is already empty.");
    return;
  }

  // ---- data-only ---------------------------------------------------------
  if (options.dataOnly) {
    const confirmed = await confirmDestructive({
      action: "Delete synced data (keeping bank links)",
      facts: [
        ["Banks", `${counts.items}  (kept — links and tokens survive)`],
        ["Transactions", `${counts.transactions}  (DELETED)`],
      ],
      consequences: [
        "Every transaction row is deleted.",
        "Each bank's cursor is cleared, so the next sync re-backfills full history.",
        "Access tokens are untouched — no re-linking needed.",
      ],
      skipPrompt: options.yes === true,
    });
    if (!confirmed) return;

    const { transactions } = await resetSyncedData();
    console.log(`\nDeleted ${transactions} transaction(s) and cleared all cursors.`);
    console.log("Run `costingly sync` to re-backfill.\n");
    return;
  }

  // ---- full wipe ---------------------------------------------------------
  const consequences = [
    `All ${counts.items} bank link(s), ${counts.accounts} account(s) and ${counts.transactions} transaction(s) are deleted.`,
    "Stored access tokens are destroyed — `costingly link` is required for every bank.",
  ];
  consequences.push(
    options.revoke
      ? "Each token is also invalidated at Plaid (/item/remove). Irreversible."
      : "Items are NOT removed at Plaid — they keep counting against your plan. Use --revoke to also invalidate them.",
  );

  const confirmed = await confirmDestructive({
    action: "Delete ALL local data",
    facts: [
      ["Banks", String(counts.items)],
      ["Accounts", String(counts.accounts)],
      ["Transactions", String(counts.transactions)],
      ["Revoke at Plaid", options.revoke ? "YES — tokens invalidated" : "no"],
    ],
    consequences,
    skipPrompt: options.yes === true,
  });
  if (!confirmed) return;

  const outcomes = await removeAllItems({ revoke: options.revoke === true });

  console.log("");
  for (const outcome of outcomes) {
    const name = outcome.institutionName ?? outcome.itemId;
    if (outcome.revokeError !== undefined) {
      console.log(`  deleted  ${name}  (Plaid revoke FAILED: ${outcome.revokeError})`);
    } else if (outcome.revoked) {
      console.log(`  deleted  ${name}  (revoked at Plaid)`);
    } else {
      console.log(`  deleted  ${name}`);
    }
  }

  const failed = outcomes.filter((outcome) => outcome.revokeError !== undefined);
  console.log(`\nRemoved ${outcomes.length} bank(s). Database is empty.`);

  if (failed.length > 0) {
    console.error(
      `\n${failed.length} item(s) could not be revoked at Plaid and may still be active.\n` +
        `Remove them from https://dashboard.plaid.com/ to stop them counting against your plan.`,
    );
    process.exitCode = 1;
  }

  if (!options.revoke) {
    console.log(
      `\nNote: the Item(s) still exist at Plaid (${get("plaidEnv")}). Re-run with --revoke,\n` +
        `or remove them in the Plaid dashboard, if you want them gone there too.`,
    );
  }
  console.log("");
}
