/**
 * `costingly uninstall` — remove everything costingly keeps on this machine.
 *
 *   costingly uninstall               revoke at Plaid, then delete the profile
 *   costingly uninstall --local-only  delete the profile, never touch Plaid
 *   costingly uninstall --yes         skip the confirmation (scripts only)
 *
 * Deletes the profile as one directory: config.json with the encryption key and
 * the Plaid credentials, the Postgres cluster with every transaction, and the
 * log. It cannot delete the program itself, so it says what is left to do.
 *
 * WHY REVOKING IS THE DEFAULT HERE AND NOT IN `reset`
 *
 * `reset` empties the database and leaves the install working, so keeping the
 * Items alive is the reasonable default — you are about to re-link them.
 * Uninstall destroys the access tokens and the key that decrypts them, and
 * Plaid can neither reissue nor look up either. An Item whose token is gone can
 * never be used again, only billed for. Revoking is therefore the only default
 * that cannot leave the user paying for something unreachable.
 */

import type { Command } from "commander";
import { platform } from "../../../domain/project.js";
import { countData } from "../../../domain/services/banks/reset.service.js";
import { uninstall } from "../../../domain/services/uninstall.service.js";
import { confirmDestructive } from "../ui/confirm.js";

interface UninstallOptions {
  localOnly?: boolean;
  yes?: boolean;
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description("Delete everything costingly keeps on this machine")
    .helpGroup("Destructive — each asks you to type the profile name:")
    .option("--local-only", "do not contact Plaid; leaves every Item alive and billing")
    .option("-y, --yes", "skip the confirmation prompt (for scripts)")
    .addHelpText(
      "after",
      `
Deletes the profile directory as a unit: config.json (encryption key, Plaid
credentials), the Postgres cluster and every transaction in it, and the log.

By default each bank is first removed at Plaid, so nothing is left billing.
--local-only skips that — the Items stay alive, and because their access tokens
go with the profile they can never be used again. Remove those by hand at
https://my.plaid.com/ if you use it.

This cannot remove the program itself. It will tell you what is left to do.`,
    )
    .action(async (options: UninstallOptions) => {
      await runUninstall(options);
    });
}

/**
 * How much is about to be lost.
 *
 * A broken database is a normal reason to be uninstalling, so failing to count
 * must not stop the command — it only means the confirmation shows less.
 */
async function describeStakes(): Promise<Array<[string, string]>> {
  try {
    const counts = await countData();
    return [
      ["Banks", String(counts.items)],
      ["Accounts", String(counts.accounts)],
      ["Transactions", String(counts.transactions)],
    ];
  } catch {
    return [["Contents", "unknown — the database could not be read"]];
  }
}

export async function runUninstall(options: UninstallOptions): Promise<void> {
  const revoke = options.localOnly !== true;

  const consequences = [
    `The profile directory is deleted: ${platform.displayPath(platform.profileDir())}`,
    "That includes config.json — your encryption key and Plaid credentials.",
    "Every synced transaction is deleted along with the database itself.",
  ];
  consequences.push(
    revoke
      ? "Each bank is first removed at Plaid, so nothing is left billing."
      : "Plaid is NOT contacted. Every Item stays alive and keeps billing — and " +
          "because its access token is deleted here, it can NEVER be used again.",
  );

  const confirmed = await confirmDestructive({
    action: "Uninstall costingly from this machine",
    facts: [...(await describeStakes()), ["Remove at Plaid", revoke ? "YES" : "no — left alive"]],
    consequences,
    skipPrompt: options.yes === true,
  });
  if (!confirmed) return;

  const result = await uninstall({ revoke });

  // ---- what happened at Plaid --------------------------------------------
  console.log("");
  for (const outcome of result.outcomes) {
    const name = outcome.institutionName ?? outcome.itemId;
    if (outcome.revokeError !== undefined) {
      console.log(`  removed locally  ${name}  (Plaid removal FAILED: ${outcome.revokeError})`);
    } else if (outcome.revoked) {
      console.log(`  removed          ${name}  (also removed at Plaid)`);
    } else {
      console.log(`  removed locally  ${name}`);
    }
  }

  if (result.revokeError !== undefined) {
    console.error(
      `\n  Warning: could not reach the database to remove banks at Plaid.\n` +
        `  ${result.revokeError}\n` +
        `  The uninstall continued. Any Items still at Plaid keep billing —\n` +
        `  check https://dashboard.plaid.com/activity/usage`,
    );
    process.exitCode = 1;
  }

  const stranded = result.outcomes.filter((outcome) => outcome.revokeError !== undefined);
  if (stranded.length > 0) {
    console.error(
      `\n  ${stranded.length} bank(s) could not be removed at Plaid and may still be billing.\n` +
        `  Their access tokens are now deleted, so they cannot be retried from here.\n` +
        `  Remove them at https://my.plaid.com/ or https://dashboard.plaid.com/`,
    );
    process.exitCode = 1;
  }

  // ---- what happened on disk ---------------------------------------------
  const where = platform.displayPath(result.profile.profileDir);
  console.log(
    result.profile.existed
      ? `\n  Profile deleted.  ${where}`
      : `\n  Nothing to delete — no profile at ${where}`,
  );

  // The one thing this command structurally cannot do.
  console.log(
    `\n  The program itself is still installed. To finish:\n` +
      `    npm uninstall -g costingly\n` +
      `  or remove the extension in Claude Desktop, if you installed it there.\n`,
  );
}
