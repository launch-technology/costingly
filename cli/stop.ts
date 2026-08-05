/**
 * `costingly stop` — shut down the local database server.
 *
 * Nothing requires this. The server starts itself on first use and staying
 * running is what lets a sync, a CLI read and the Claude Desktop integration
 * work at the same time. This exists for when you want the process gone: before
 * a backup, to free memory, or just to be sure nothing is holding your financial
 * data open.
 *
 * Not destructive — no data is touched, and the next command starts it again.
 */

import type { Command } from "commander";
import { stopServer, usingRemoteDatabase, clusterDir } from "../src/index.js";
import { CliError } from "./errors.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Shut down the local database server (data is untouched)")
    .helpGroup("Looking at your data:")
    .addHelpText(
      "after",
      `
The server restarts automatically the next time you run any command. Your data
is not affected — this only stops the process.`,
    )
    .action(async () => {
      await runStop();
    });
}

export async function runStop(): Promise<void> {
  if (usingRemoteDatabase()) {
    throw new CliError(
      "DATABASE_URL is set, so costingly is not managing a database server.\n" +
        "There is nothing here to stop.",
    );
  }

  const wasRunning = await stopServer();
  console.log(
    wasRunning
      ? `Database stopped.  ${clusterDir()}`
      : "Database was not running.",
  );
}
