/**
 * One application's database, and everything with a lifetime attached to it.
 *
 * The object that coordinates the pieces: it holds the registry, builds each
 * DataSource out of a ConnectionFactory, wires provisioning into the app
 * source's first use, and is the one thing that can shut the process's
 * connections down.
 *
 * Composed, never self-assembling. It is handed a factory and a migration step
 * rather than importing them, so the whole graph can be built differently — a
 * test cluster, a second profile — without this file knowing.
 *
 * TWO KINDS OF SOURCE, AND THEY ARE NOT SYMMETRIC
 *
 *   app     pooled, as the runtime role, against the project's database.
 *           Provisions the whole stack on first use.
 *   admin   unpooled, as the superuser, against whichever database is named.
 *           Provisions NOTHING.
 *
 * The asymmetry is load-bearing rather than an oversight. Provisioning is what
 * the admin source is *for* — it creates the database and the role the app
 * source needs — so an admin source that provisioned on first use would call
 * itself forever.
 */

import { ConnectionFactory } from "./connection-factory.js";
import { LocalPostgres } from "./local-postgres.js";
import { SchemaProvisioner, type SchemaDefinition } from "./schema-provisioner.js";
import { DataSourceRegistry } from "./data-source-registry.js";
import { PooledDataSource } from "./pooled-data-source.js";
import { TransientDataSource } from "./transient-data-source.js";
import type { DataSource } from "./types/data-source.js";
import type { PostgresServer } from "./server.js";

const APP = "app";

export class Database {
  private readonly registry = new DataSourceRegistry();
  private readonly pooled: PooledDataSource;

  constructor(
    private readonly factory: ConnectionFactory,
    postgres: PostgresServer,
    schema: SchemaDefinition,
    private readonly databaseName: string,
  ) {
    const admin = (name: string): DataSource => this.admin(name);
    const cluster = new LocalPostgres(admin, postgres, databaseName);
    const provisioner = new SchemaProvisioner(admin, schema, postgres, databaseName);

    // The two phases, in the only order that works: a schema cannot be applied
    // to a database that does not exist, and neither can happen through the
    // pool, which authenticates as a role the schema creates.
    //
    // Lazy by construction: both are inside the closure the pooled source calls
    // on its first query, never on the way to building this object. A diagnostic
    // command has to work when the cluster will not start, so having a Database
    // must never mean having started one.
    this.pooled = new PooledDataSource(async () => {
      await cluster.ensureRunning();
      await provisioner.apply();
      return this.factory.createAppPool();
    }, "local PostgreSQL");

    this.registry.register(APP, this.pooled);
  }

  /** The application database. What services and repositories are given. */
  get app(): DataSource {
    return this.registry.get(APP);
  }

  /**
   * The superuser, against one named database.
   *
   * Registered on first request and reused. There is no connection behind it
   * between calls, so this caches an object rather than a resource — what it
   * buys is that `all()` can see every source that exists, not a saving.
   */
  admin(database: string = this.databaseName): DataSource {
    const name = `admin:${database}`;
    return (
      this.registry.find(name) ??
      this.registry.register(
        name,
        new TransientDataSource(
          () => this.factory.connectAsSuperuser(database),
          `local PostgreSQL as superuser (${database})`,
        ),
      )
    );
  }

  /**
   * A DataSource that only LOOKS: no provisioning, no allocation, no writes.
   *
   * Both other sources bring things into being on first use — the app source
   * starts the cluster and applies the schema, the admin source allocates a
   * port and generates logins. That is right for work, and wrong for a report:
   * a health check that provisions cannot answer "is anything here?", because
   * by the time it replies the answer is yes.
   *
   * Fails loudly on a profile that was never set up, and the failure is the
   * finding. Nothing is registered or cached — this holds no connection between
   * calls and has no lifetime to manage.
   */
  inspector(): DataSource {
    return new TransientDataSource(
      () => this.factory.connectAsRecordedSuperuser(),
      "local PostgreSQL (inspection only)",
    );
  }

  /** True once something has actually opened the application pool. */
  isOpen(): boolean {
    return this.pooled.isOpen();
  }

  /**
   * Everything in phases one and two, done once and cached.
   *
   * Idempotent, and safe to call concurrently — the pooled source joins one
   * attempt rather than starting a second. A CLI command awaits this before
   * doing anything; a long-lived server fires it at startup without awaiting,
   * so the handshake is not held up by a cold install.
   */
  async ensureReady(): Promise<void> {
    await this.app.query("SELECT 1");
  }

  /**
   * Release every connection this process holds, so it can exit.
   *
   * Does NOT stop the server — that is shared and long-lived, and stopping it
   * is a separate command. Sources reopen on their next query, which
   * is what makes this safe to call from a `finally`.
   */
  async shutdown(): Promise<void> {
    for (const source of this.registry.all()) {
      await source.close?.();
    }
  }
}
