/**
 * `costingly unlink` — remove a single bank.  DESTRUCTIVE.
 *
 *   costingly unlink                 pick a bank from a list
 *   costingly unlink chase           match by name, skip the picker
 *   costingly unlink chase --revoke  ...and invalidate its token at Plaid
 *
 * For wiping everything at once, use `costingly reset`.
 */

import type { Command } from "commander";
import { select, isCancel, cancel } from "@clack/prompts";
import { stdin } from "node:process";
import { listAllItems, type StoredItem } from "../../../data/repositories/items.repository.js";
import { countItemData, removeItem } from "../../../services/banks/unlink.service.js";
import { confirmDestructive } from "../ui/confirm.js";

function label(item: StoredItem): string {
  return item.institutionName ?? `(unknown bank) ${item.itemId}`;
}

async function pickItem(items: StoredItem[]): Promise<StoredItem | null> {
  const width = Math.max(...items.map((item) => label(item).length));

  const options = await Promise.all(
    items.map(async (item) => {
      const stats = await countItemData(item.itemId);
      const flag = item.status === "active" ? "" : `  [${item.status}]`;
      return {
        value: item.itemId,
        label:
          `${label(item).padEnd(width)}  ` +
          `${String(stats.accounts).padStart(2)} accounts  ` +
          `${String(stats.transactions).padStart(5)} txns${flag}`,
      };
    }),
  );

  const choice = await select({ message: "Which bank do you want to unlink?", options });

  if (isCancel(choice)) {
    cancel("Aborted. Nothing was deleted.");
    return null;
  }
  return items.find((item) => item.itemId === choice) ?? null;
}

interface UnlinkOptions {
  revoke?: boolean;
  yes?: boolean;
}

export function registerUnlinkCommand(program: Command): void {
  program
    .command("unlink")
    .description("Remove one bank and its data")
    .helpGroup("Destructive — each asks you to type the environment name:")
    .argument("[bank...]", "bank name to match (skips the picker)")
    .option("--revoke", "also invalidate the access token at Plaid (/item/remove)")
    .option("-y, --yes", "skip the confirmation prompt (for scripts)")
    .addHelpText(
      "after",
      `
Deleting locally does NOT remove the Item at Plaid — it keeps existing and keeps
counting against your plan. Use --revoke to invalidate it there as well.

To remove every bank at once:  costingly reset`,
    )
    .action(async (bank: string[], options: UnlinkOptions) => {
      await runUnlink(bank, options);
    });
}

export async function runUnlink(
  bank: readonly string[],
  options: UnlinkOptions,
): Promise<void> {
  const nameQuery = bank.length > 0 ? bank.join(" ").toLowerCase() : null;

  const allItems = await listAllItems();
  if (allItems.length === 0) {
    console.log("No banks linked. Nothing to unlink.");
    return;
  }

  const matches =
    nameQuery === null
      ? allItems
      : allItems.filter(
          (item) =>
            (item.institutionName ?? "").toLowerCase().includes(nameQuery) ||
            item.itemId.toLowerCase() === nameQuery,
        );

  if (matches.length === 0) {
    console.log(`No bank matches "${nameQuery}". Run \`costingly unlink\` to pick from a list.`);
    process.exitCode = 1;
    return;
  }

  let target: StoredItem | null;
  if (matches.length === 1) {
    target = matches[0]!;
  } else if (stdin.isTTY !== true) {
    console.log(`\n${matches.length} banks match — name one explicitly:\n`);
    for (const item of matches) console.log(`  ${label(item)}`);
    console.log("");
    process.exitCode = nameQuery === null ? 0 : 1;
    return;
  } else {
    target = await pickItem(matches);
  }
  if (target === null) return;

  const stats = await countItemData(target.itemId);
  const consequences = [
    `${stats.accounts} account(s) and ${stats.transactions} transaction(s) for this bank are deleted.`,
    "Its stored access token is destroyed — re-link with `costingly link` to restore it.",
    options.revoke
      ? "The token is also invalidated at Plaid (/item/remove). Irreversible."
      : "The Item is NOT removed at Plaid — it keeps counting against your plan. Use --revoke.",
  ];

  const confirmed = await confirmDestructive({
    action: `Unlink ${label(target)}`,
    facts: [
      ["Bank", label(target)],
      ["Item", target.itemId],
      ["Accounts", String(stats.accounts)],
      ["Transactions", String(stats.transactions)],
      ["Revoke at Plaid", options.revoke ? "YES — token invalidated" : "no"],
    ],
    consequences,
    skipPrompt: options.yes === true,
  });
  if (!confirmed) return;

  const outcome = await removeItem(target, { revoke: options.revoke === true });

  console.log(`\nUnlinked ${label(target)}.`);
  if (outcome.revokeError !== undefined) {
    console.error(
      `Plaid revoke FAILED: ${outcome.revokeError}\n` +
        `The local rows are gone, but the Item may still be active at Plaid.\n` +
        `Remove it from https://dashboard.plaid.com/ if so.`,
    );
    process.exitCode = 1;
  } else if (outcome.revoked) {
    console.log("Access token invalidated at Plaid.");
  }
  console.log("");
}
