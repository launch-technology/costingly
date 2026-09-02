/**
 * Phase two: the database has the shape an application expects.
 *
 * Applies the migrations it is given and gives the runtime role its password.
 * The MECHANISM is reusable; the CONTENT is not, which is why the migrations
 * arrive as a `SchemaDefinition` rather than being read from a folder this
 * class picks. A second application supplies its own and reuses everything else.
 *
 * Runs as the superuser on unpooled connections, before the pool exists.
 * Migrations create the runtime role itself, so they cannot run through a pool
 * that authenticates as it — on a fresh cluster that role does not exist yet.
 */

import { applyPendingMigrations, type Migration } from "./migrations.js";
import { DATABASE_NAME, databaseCredentials } from "./server.js";
import type { DataSource } from "./types/data-source.js";

/** What an application says its database should look like. */
export interface SchemaDefinition {
  /** Every migration, in the order they must be applied. */
  migrations(): Promise<Migration[]>;
}

/** Arbitrary but fixed, like the migration lock. */
const APP_PASSWORD_LOCK = 4_812_233;

export class SchemaProvisioner {
  constructor(
    private readonly admin: (database: string) => DataSource,
    private readonly schema: SchemaDefinition,
  ) {}

  /** Bring the schema up to date and make the runtime role usable. */
  async apply(): Promise<void> {
    await applyPendingMigrations(this.admin(DATABASE_NAME), await this.schema.migrations());
    await this.applyAppPassword();
  }

  /**
   * Give the runtime role the password we generated for it.
   *
   * The migration creates the role but cannot set its password: migration files
   * are committed and secrets are not. Idempotent and cheap, so it runs on
   * every start — which also repairs a cluster whose role lost its password
   * without needing a separate recovery path.
   *
   * `ALTER ROLE` accepts no bind parameters, so the password is interpolated.
   * The assertion is what makes that safe rather than hopeful: generatePassword()
   * produces base64url, and anything outside that alphabet means something has
   * changed upstream and this needs revisiting before it becomes an injection.
   */
  private async applyAppPassword(): Promise<void> {
    const { logins } = await databaseCredentials();
    const { user, password } = logins.app;

    if (!/^[A-Za-z0-9_-]+$/.test(password) || !/^[a-z_][a-z0-9_]*$/.test(user)) {
      throw new Error(
        "Refusing to set the database password: the generated credentials contain " +
          "characters this code does not know how to escape.",
      );
    }

    await this.admin(DATABASE_NAME).transaction(async (tx) => {
      // Serialised across processes. ALTER ROLE writes a pg_authid row, and six
      // CLI commands starting at once produce "tuple concurrently updated".
      //
      // try_ rather than plain: whoever holds it is doing the same work, so the
      // right move is to skip, not to queue behind them. _xact_ rather than the
      // session form: the lock then releases with the COMMIT that ends this
      // transaction, so there is no unlock to forget and no way for a failure
      // between the two to strand it.
      const got = await tx.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1) AS locked",
        [APP_PASSWORD_LOCK],
      );
      if (got.rows[0]?.locked !== true) return;

      await tx.query(`ALTER ROLE ${user} LOGIN PASSWORD '${password}'`);
    });
  }
}
