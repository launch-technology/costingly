/**
 * `costingly migrate` — apply any migrations this database has not run.
 *
 * Almost never needed. The same thing happens automatically on the first
 * database connection of every command, because a bundled install has no
 * terminal to run this in. What remains is an explicit handle for when you want
 * to see what happened, or to force the check without doing anything else.
 */

import type { Command } from "commander";
import { withTransaction } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadMigrations } from "./migrations.js";
import { CliError } from "./errors.js";

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description("Apply any pending database migrations (usually automatic)")
    .helpGroup("Looking at your data:")
    .addHelpText(
      "after",
      `
Migrations run by themselves the first time any command opens the database, so
this is only useful for seeing what is pending or confirming there is nothing.`,
    )
    .action(async () => {
      try {
        await runMigrate();
      } catch (error) {
        throw new CliError(
          `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

export async function runMigrate(): Promise<void> {
  const migrations = await loadMigrations();

  // Opening the connection has almost certainly applied these already — this is
  // the same call the driver makes. Running it again is how the command reports
  // rather than acts, and it is safe: the ledger makes it a no-op.
  const applied = await withTransaction((client) => runMigrations(client, migrations));

  if (applied.length === 0) {
    console.log(`Database is up to date (${migrations.length} migration(s) applied).`);
    return;
  }
  console.log(`Applied ${applied.length} migration(s):`);
  for (const id of applied) console.log(`  ${id}`);
}
