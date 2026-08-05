/**
 * Apply schema.sql.  Usage:  npm run migrate
 *
 * schema.sql is entirely IF NOT EXISTS, so this is safe to re-run. It is
 * executed as one multi-statement query, which pg wraps in an implicit
 * transaction — the schema either applies completely or not at all.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { query, closePool } from "../src/db.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(projectRoot, "schema.sql");

async function main(): Promise<void> {
  const sql = await readFile(schemaPath, "utf8");

  console.log(`Applying ${schemaPath} ...`);
  await query(sql);

  const tables = await query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );

  console.log(`Done. Tables: ${tables.rows.map((row) => row.table_name).join(", ") || "(none)"}`);
}

main()
  .then(async () => {
    await closePool();
  })
  .catch(async (error: unknown) => {
    console.error("Migration failed:", error instanceof Error ? error.message : error);
    await closePool();
    process.exitCode = 1;
  });
