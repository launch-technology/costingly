/**
 * Reading the migrations off disk.
 *
 * Deliberately in cli/ rather than src/: it resolves a path from the package
 * root, which is `import.meta.url` work that src/ avoids on purpose (see the
 * header of paths.ts). src/db/migrate.ts takes migrations as data and never
 * touches the filesystem.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Migration } from "../src/db/migrations.js";
import { migrationsDir } from "./paths.js";

/**
 * Every migration, in filename order.
 *
 * Plain string sort, which is why the files are zero-padded — `0010` must come
 * after `0009`, and `10` would not.
 */
export async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  return Promise.all(
    files.map(async (file) => ({
      id: file.replace(/\.sql$/, ""),
      sql: await readFile(join(migrationsDir, file), "utf8"),
    })),
  );
}
