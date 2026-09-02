/**
 * The Database this application uses, assembled once.
 *
 * The composition root for the data layer: the only place the object graph is
 * built. Everything else imports the result.
 *
 * `db` is exported alongside it because that is what the rest of the codebase
 * actually wants — a DataSource to hand to a repository. Reaching through
 * `database.app` everywhere would say nothing extra.
 */

import { ConnectionFactory } from "../../platform/postgres/connection-factory.js";
import { Database } from "../../platform/postgres/database.js";
import { loadMigrations } from "../../platform/postgres/migrations.js";
import type { DataSource } from "../../platform/postgres/types/data-source.js";

// Cached on globalThis because Next.js hot reloads re-evaluate modules and warm
// serverless containers reuse the process — a second Database over the same
// cluster would double the connection count without anyone asking for it.
const globalForDb = globalThis as typeof globalThis & {
  __costinglyDatabase?: Database | undefined;
};

function resolve(): Database {
  const existing = globalForDb.__costinglyDatabase;
  if (existing) return existing;

  // Costingly's schema: the numbered .sql files this package ships. The
  // provisioner supplies the mechanism; this names the content.
  const created = new Database(new ConnectionFactory(), { migrations: loadMigrations });
  globalForDb.__costinglyDatabase = created;
  return created;
}

/** This process's database. */
export const database: Database = resolve();

/** Its application DataSource — the one repositories are handed. */
export const db: DataSource = database.app;

/** The superuser, against one named database. */
export function adminDataSource(name?: string): DataSource {
  return database.admin(name);
}

/**
 * Close this process's connections. Call at the end of a CLI run so it can exit.
 *
 * Kept as a function rather than making every caller reach for
 * `database.shutdown()`: teardown is called from `finally` blocks that should
 * say what they do and nothing more.
 */
export async function closeDb(): Promise<void> {
  await database.shutdown();
}
