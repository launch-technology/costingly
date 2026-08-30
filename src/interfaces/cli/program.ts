/**
 * The command tree.
 *
 * Declaration only: this names the commands, their order in help, and the
 * text around them. It parses nothing and runs nothing — main.ts owns the
 * process. Registration order is help order.
 */

import { Command } from "commander";
import { environmentBanner } from "./ui/banner.js";
import { packageVersion } from "../../core/package.js";

import { registerInitCommand } from "./commands/init.command.js";
import { registerMigrateCommand } from "./commands/migrate.command.js";
import { registerLinkCommand } from "./commands/link.command.js";
import { registerSyncCommand } from "./commands/sync.command.js";
import { registerStatusCommand } from "./commands/status.command.js";
import { registerTransactionsCommand } from "./commands/transactions.command.js";
import { registerUnlinkCommand } from "./commands/unlink.command.js";
import { registerResetCommand } from "./commands/reset.command.js";
import { registerStopCommand } from "./commands/stop.command.js";
import { registerDoctorCommand } from "./commands/doctor.command.js";
import { registerMcpCommand } from "./commands/mcp.command.js";
import { registerSeedCommand } from "./commands/seed.command.js";

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
  registerMcpCommand(program);
  registerLinkCommand(program);
  registerSyncCommand(program);
  registerStatusCommand(program);
  registerTransactionsCommand(program);
  registerStopCommand(program);
  registerDoctorCommand(program);
  registerSeedCommand(program);
  registerUnlinkCommand(program);
  registerResetCommand(program);

  return program;
}
