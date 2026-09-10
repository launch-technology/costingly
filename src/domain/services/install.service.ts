/**
 * Setting costingly up on this machine.
 *
 * Two things, and only the second is costingly's:
 *
 *   1. Make sure the datastore exists and is usable.
 *   2. Make sure the encryption key exists, because stored bank tokens are
 *      useless without one.
 *
 * The first is one call. The ORDER inside it — create, start, wait for
 * readiness, create the database, migrate, set the runtime password — is
 * knowledge of whatever backs the datastore, not of costingly, so it lives in
 * the adapter. This service would not know how to sequence it and should not
 * have to: nothing here names PostgreSQL.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * Plaid credentials. They cannot be obtained here — they come from `costingly
 * init`'s prompts or from the extension's settings — so a successful install
 * routinely leaves them missing, and that is not a failure. Reporting what is
 * still missing is `status`'s job.
 *
 * Idempotent. Running it on a working profile costs a few state checks.
 */

import { loadMigrations } from "../../platform/postgres/migrations.js";
import { server } from "../project.js";
import { ensureKey } from "../crypto.js";

/**
 * Install costingly, or bring an existing install up to date.
 *
 * Throws with a usable message on failure. There is no return value on
 * purpose — "did it work" is the exception, and "what is the state now" is a
 * question `costinglyStatus()` already answers better than a summary invented
 * here would.
 */
export async function install(): Promise<void> {
  // Before the datastore, deliberately. The key protects what the datastore
  // will hold, and generating it is cheap and local — so a failure to build a
  // database does not leave a profile that also has no key.
  ensureKey();

  await server.install({ migrations: loadMigrations });
}
