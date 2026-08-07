/**
 * `costingly migrate` — apply schema.sql.
 *
 * schema.sql is entirely IF NOT EXISTS, so this is safe to re-run. It is
 * executed as one multi-statement query, which pg wraps in an implicit
 * transaction — the schema either applies completely or not at all.
 */

import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { execScript, query } from "../src/db/client.js";
import { schemaPath } from "./paths.js";
import { CliError } from "./errors.js";

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description("Create the database tables (safe to re-run)")
    .helpGroup("Setup — run once, in this order:")
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
  // schemaPath comes from paths.ts, which walks up to package.json. Resolving
  // it relative to this module would be off by one once compiled into dist/.
  const sql = await readFile(schemaPath, "utf8");

  console.log(`Applying ${schemaPath} ...`);
  // schema.sql is multi-statement. execScript sends it as one string, which pg
  // wraps in an implicit transaction.
  await execScript(sql);

  const tables = await query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );

  console.log(`Done. Tables: ${tables.rows.map((row) => row.table_name).join(", ") || "(none)"}`);
}
