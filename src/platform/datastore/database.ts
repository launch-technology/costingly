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

import { ConnectionFactory } from "../postgres/connection-factory.js";
import { DatabaseNotSetUpError } from "../postgres/errors.js";
import { DataSourceRegistry } from "../postgres/data-source-registry.js";
import { PooledDataSource } from "../postgres/pooled-data-source.js";
import { TransientDataSource } from "../postgres/transient-data-source.js";
import type { DataSource } from "../postgres/types/data-source.js";
import type { Datastore } from "./datastore.js";

const APP = "app";

export class Database {
  private readonly registry = new DataSourceRegistry();
  private readonly pooled: PooledDataSource;
  private readonly postgres: Datastore;

  constructor(
    private readonly factory: ConnectionFactory,
    postgres: Datastore,
    private readonly databaseName: string,
  ) {
    this.postgres = postgres;

    // CREATING IS NOT A SIDE EFFECT OF READING
    //
    // This closure used to call `ensureRunning()` and `apply()` unconditionally,
    // which meant every SELECT in the codebase carried the authority to run
    // `initdb`, write a cluster to the user's disk and generate credentials.
    // Nothing distinguished a caller that wanted a database built from one that
    // only wanted to look — so a status report recreated a profile that had just
    // been deleted, and `uninstall` built a database in order to describe what it
    // was about to remove.
    //
    // Now: an absent cluster is refused. Creating one is `ensureReady()`, which
    // callers invoke deliberately.
    //
    // STARTING a stopped server stays implicit, and the distinction is the whole
    // point. Starting resumes something that already exists and creates nothing;
    // after a reboot the next command should just work, which is what
    // "the server starts itself" has always meant.
    this.pooled = new PooledDataSource(async () => {
      if ((await this.postgres.status()) === "uninitialised") {
        throw new DatabaseNotSetUpError(
          "There is no database here yet.\n\n" +
            "Nothing has been created in this profile, and reading from it will not " +
            "create it — that is a deliberate step.",
        );
      }
      // START, never provision. The service split makes that a property of the
      // call rather than of this comment: `start()` cannot run initdb.
      await this.postgres.start();
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

  /** True once something has actually opened the application pool. */
  isOpen(): boolean {
    return this.pooled.isOpen();
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
