#!/usr/bin/env node
/**
 * plaid-sync — single entry point for every command.
 *
 * Everything process-wide happens here exactly once: .env loading, the EPIPE
 * guard, argv parsing, and closing the pg pool. Command modules only declare
 * their flags and do their work — none of them parses argv or touches the
 * process lifecycle.
 *
 * The shebang must be the first bytes of this file: tsc only preserves it at
 * position 0, and it is what makes dist/cli/index.js directly executable.
 */

import { Command } from "commander";
import { closeDb } from "../src/db.js";
import { ignoreEpipe } from "./format.js";
import { loadEnv, configFromArgv } from "./env.js";
import { environmentBanner } from "./banner.js";
import { CliError } from "./errors.js";
import { packageVersion } from "./paths.js";

import { registerKeygenCommand } from "./keygen.js";
import { registerMigrateCommand } from "./migrate.js";
import { registerLinkCommand } from "./link.js";
import { registerSyncCommand } from "./sync.js";
import { registerStatusCommand } from "./status.js";
import { registerTransactionsCommand } from "./transactions.js";
import { registerUnlinkCommand } from "./unlink.js";
import { registerResetCommand } from "./reset.js";

/**
 * Build the command tree without parsing.
 *
 * Separate from main() so tests can inspect or drive it via
 * `program.parseAsync([...], { from: "user" })`.
 */
export function buildProgram(): Command {
  const program = new Command()
    .name("plaid-sync")
    .description("Daily sync of bank and credit-card transactions from Plaid into Postgres.")
    .version(packageVersion(), "-V, --version")
    // Not --env-file: that is a Node CLI flag and node would eat it first.
    .option("--config <path>", "read configuration from this file instead of ./.env")
    .showHelpAfterError("(run `plaid-sync --help` for the command list)")
    .addHelpText("before", environmentBanner())
    .addHelpText(
      "after",
      `
Per-command flags:  plaid-sync <command> --help
`,
    );

  // Registration order is help order. .helpGroup() on each command produces the
  // grouped catalog the old hand-rolled help.ts used to print.
  registerKeygenCommand(program);
  registerMigrateCommand(program);
  registerLinkCommand(program);
  registerSyncCommand(program);
  registerStatusCommand(program);
  registerTransactionsCommand(program);
  registerUnlinkCommand(program);
  registerResetCommand(program);

  return program;
}

async function main(): Promise<void> {
  ignoreEpipe();
  loadEnv(configFromArgv(process.argv));

  const program = buildProgram();

  // Bare `plaid-sync` prints the catalog and exits 0.
  //
  // Deliberately not a root .action(): commander only reports "unknown command
  // 'foo'" (with a did-you-mean) while the root program has no action handler.
  // Adding one turns a typo into a confusing "too many arguments" error.
  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}

main()
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Safe unconditionally: closeDb() returns early when nothing was opened,
    // so commands like keygen cost nothing.
    await closeDb();
  });
