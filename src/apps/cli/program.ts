/**
 * The command tree.
 *
 * Declaration only: this names the commands, their order in help, the text
 * around them, and the one thing that happens before any of them runs. It
 * parses nothing and runs nothing — main.ts owns the process. Registration
 * order is help order.
 */

import { Command } from "commander";
import { environmentBanner } from "./ui/banner.js";
import { packageVersion } from "../../platform/package.js";
import { resumeDatabase } from "../../domain/services/database/database-health.service.js";

import { registerInitCommand } from "./commands/init.command.js";
import { registerMigrateCommand } from "./commands/migrate.command.js";
import { registerLinkCommand } from "./commands/link.command.js";
import { registerSyncCommand } from "./commands/sync.command.js";
import { registerStatusCommand } from "./commands/status.command.js";
import { registerTransactionsCommand } from "./commands/transactions.command.js";
import { registerUnlinkCommand } from "./commands/unlink.command.js";
import { registerResetCommand } from "./commands/reset.command.js";
import { registerUninstallCommand } from "./commands/uninstall.command.js";
import { registerStopCommand } from "./commands/stop.command.js";
import { registerSeedCommand } from "./commands/seed.command.js";

/**
 * Commands the CLI does not start the database for.
 *
 *   status      reports the server as it is; starting it would change the answer
 *   stop        is the opposite request
 *   init        creates and starts it itself, after asking
 *   migrate     likewise starts it itself
 *   uninstall   decides for itself: it needs the database only to revoke banks
 */
const LEAVES_THE_SERVER_ALONE = new Set(["status", "stop", "init", "migrate", "uninstall"]);

/**
 * Build the command tree without parsing.
 *
 * Separate from main() so tests can inspect or drive it via
 * `program.parseAsync([...], { from: "user" })`.
 */
export function buildProgram(): Command {
  const _packageVersion = packageVersion();
  const program = new Command()
    .name("costingly")
    .description("Daily sync of bank and credit-card transactions from Plaid into Postgres.")
    .version(_packageVersion, "-V, --version")
    .showHelpAfterError("(run `costingly --help` for the command list)")
    .addHelpText("before", environmentBanner())
    .addHelpText(
      "after",
      `
Per-command flags:  costingly <command> --help
`,
    );

  // Registration order is help order. .helpGroup() on each command produces the
  // grouped catalog the old hand-rolled help.ts used to print.
  registerInitCommand(program);
  registerMigrateCommand(program);
  registerLinkCommand(program);
  registerSyncCommand(program);
  registerStatusCommand(program);
  registerTransactionsCommand(program);
  registerStopCommand(program);
  registerSeedCommand(program);
  registerUnlinkCommand(program);
  registerResetCommand(program);
  registerUninstallCommand(program);

  // THE CLI STARTS THE DATABASE BEFORE A COMMAND THAT NEEDS IT.
  //
  // Nothing starts the server as a side effect of querying it any more, and a
  // command typed after a reboot should still just work. So the commands that
  // read or write data resume a stopped server first — here, once, rather
  // than in each of them. Resuming creates nothing: with no database yet it
  // does nothing, and the command's own first query says there is none.
  program.hook("preAction", async (_program, command) => {
    if (!LEAVES_THE_SERVER_ALONE.has(command.name())) await resumeDatabase();
  });

  return program;
}
