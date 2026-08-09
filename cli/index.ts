#!/usr/bin/env node
/**
 * costingly — single entry point for every command.
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
import { closeDb, setMigrationSource } from "../src/db/client.js";
import { setPublicDir } from "../src/link/server.js";
import { isMissingSchema, MISSING_SCHEMA_CLI } from "../src/db/errors.js";
import { ignoreEpipe } from "./format.js";
import { environmentBanner } from "./banner.js";
import { CliError } from "./errors.js";
import { packageVersion, publicDir } from "./paths.js";
import { loadMigrations } from "./migrations.js";

import { registerInitCommand } from "./init.js";
import { registerMigrateCommand } from "./migrate.js";
import { registerLinkCommand } from "./link.js";
import { registerSyncCommand } from "./sync.js";
import { registerStatusCommand } from "./status.js";
import { registerTransactionsCommand } from "./transactions.js";
import { registerUnlinkCommand } from "./unlink.js";
import { registerResetCommand } from "./reset.js";
import { registerStopCommand } from "./stop.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerMcpCommand } from "./mcp.js";

// Reading migrations/ means resolving a path from import.meta.url, which src/
// does not do (see the header of paths.ts). Registering the loader here — at the
// one entry point every command shares — lets the driver migrate the database
// itself on first connection, so nobody has to run `costingly migrate`. That
// matters most where there is no terminal to run it in: a bundled install.
setMigrationSource(loadMigrations);
setPublicDir(publicDir);

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
  registerUnlinkCommand(program);
  registerResetCommand(program);

  return program;
}

async function main(): Promise<void> {
  ignoreEpipe();

  // A .env in the current directory is an optional convenience for CI and for
  // development — a way to set environment variables, nothing more. It is never
  // written by costingly and never holds application state; real configuration
  // lives in config.json inside the profile. Absent is the normal case, and
  // loadEnvFile throws when the file is missing, so the throw is swallowed.
  try {
    process.loadEnvFile();
  } catch {
    // No .env here. Expected.
  }

  const program = buildProgram();

  // Bare `costingly` prints the catalog and exits 0.
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
    // Postgres `undefined_table`. On a fresh install this is the very first
    // thing a user hits — the cluster exists but has no schema — and the raw
    // `relation "items" does not exist` is a terrible first impression. The MCP
    // server hits the same error and needs a different wording, so the test for
    // it lives in src/db/errors.ts and both surfaces share it.
    if (isMissingSchema(error)) {
      console.error(MISSING_SCHEMA_CLI);
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Safe unconditionally: closeDb() returns early when nothing was opened,
    // so commands that never query cost nothing.
    await closeDb();
  });
