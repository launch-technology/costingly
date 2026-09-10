/**
 * A datastore backed by a local PostgreSQL, bound to one profile.
 *
 * The adapter between what an application wants — somewhere its data lives,
 * that it can install, start, stop and connect to — and the PostgreSQL services
 * that provide it. Everything specific to Postgres stops here.
 *
 * WHY THIS IS NOT UNDER postgres/
 *
 * Everything in `platform/postgres/` is deliberately ignorant of profiles and
 * config files — it is handed a directory and a port and drives PostgreSQL
 * against them. This class is the one place that decides WHICH directory and
 * WHICH port, which is why it is the one place needing a `PlatformConfig` and a
 * `ConfigStore`. Keeping it out of `postgres/` is what lets that folder be
 * lifted into another project whole.
 *
 * WHAT IT OWNS: THE DECISIONS, REMEMBERING THEM, AND THE ORDER
 *
 * The paths are computed. The port and the credentials are not — they are
 * decided once and stored, because every process has to agree. Two processes
 * that each allocated a port would start two servers or collide on the data
 * directory lock; two that each generated a superuser password would leave the
 * second unable to authenticate against the cluster the first created.
 *
 * And the ORDER in `install()`, which is the part that cannot move up. Waiting
 * for readiness because a bound TCP port is not a ready server, creating the
 * database from `postgres` because one cannot be created from inside itself,
 * setting the role password separately because migrations are committed and
 * secrets are not — every one of those is a fact about PostgreSQL. A caller
 * sequencing them itself would have to know them.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ConfigStore, DatabaseLogins } from "../config-store.js";
import type { PlatformConfig } from "../platform-config.js";
import type { PortService } from "../port-allocator.js";
import { ConnectionFactory } from "../postgres/connection-factory.js";
import { ROLE_APP, ROLE_SUPERUSER, type DbCredentials } from "../postgres/credentials.js";
import { PG_MAJOR, PgBinariesService } from "../postgres/services/pg-binaries-service.js";
import { PgClusterService } from "../postgres/services/pg-cluster-service.js";
import { PgDatabaseService } from "../postgres/services/pg-database-service.js";
import { PgServerService } from "../postgres/services/pg-server-service.js";
import { TransientDataSource } from "../postgres/transient-data-source.js";
import type { DataSource } from "../postgres/types/data-source.js";
import { OsService } from "../services/os-service.js";
import type {
  Datastore,
  DatastoreState,
  Endpoint,
  SchemaDefinition,
} from "./datastore.js";

/** Loopback only. Never 0.0.0.0 — that would put the data on the network. */
const HOST = "127.0.0.1";

/** 24 random bytes. Long enough that nothing is gained by making it longer. */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Build the datastore for one profile. */
export function createDatastore(
  config: PlatformConfig,
  store: ConfigStore,
  ports: () => PortService,
): Datastore {
  return new PostgresDatastore(config, store, ports);
}

export class PostgresDatastore implements Datastore {
  constructor(
    private readonly config: PlatformConfig,
    private readonly store: ConfigStore,
    private readonly ports: () => PortService,
  ) {}

  // --- identity -------------------------------------------------------------

  dataDir(): string {
    return join(this.config.profileDir(), `pg${PG_MAJOR}`);
  }

  logPath(): string {
    return `${this.dataDir()}.log`;
  }

  /**
   * Generate and store the logins, unless they already exist.
   *
   * CALLED ONLY FROM `install()`. Reading them is `credentials()`, which returns
   * undefined rather than inventing a set — the two used to be one method, and
   * every caller that merely wanted to look wrote a password to disk.
   *
   * Both are stored BEFORE the cluster is created, so a crash midway leaves
   * credentials describing a cluster that does not exist yet — recoverable —
   * rather than a cluster nothing holds the password for.
   */
  private decideLogins(): DatabaseLogins {
    const existing = this.store.readDatabaseLogins();
    if (existing !== undefined) return existing;

    const created: DatabaseLogins = {
      superuser: { user: ROLE_SUPERUSER, password: generatePassword() },
      app: { user: ROLE_APP, password: generatePassword() },
    };
    this.store.writeDatabaseLogins(created);
    return created;
  }

  // --- the services, built fresh on every call ------------------------------
  //
  // `config.profileDir()` reads the home variable at call time, and the test
  // suite changes it between assertions. A cached instance would answer for
  // whichever profile happened to be active first — the kind of bug that only
  // shows up as one suite quietly reading another suite's database.

  private binaries(): PgBinariesService {
    return new PgBinariesService(new OsService());
  }

  private cluster(): PgClusterService {
    return new PgClusterService(this.dataDir(), this.binaries());
  }

  private postmaster(): PgServerService {
    return new PgServerService(this.dataDir(), this.logPath(), this.binaries());
  }

  /**
   * A superuser connection, built from this datastore's own credentials.
   *
   * Its own rather than borrowed from `Database`: installing has to work before
   * any application pool can exist, because the role such a pool authenticates
   * as is created by the migrations this runs.
   */
  private databases(): PgDatabaseService {
    const factory = new ConnectionFactory(this);
    return new PgDatabaseService(
      (name: string): DataSource =>
        new TransientDataSource(
          () => factory.connectAsSuperuser(name),
          `local PostgreSQL as superuser (${name})`,
        ),
    );
  }

  // --- operations -----------------------------------------------------------

  /**
   * Where this datastore listens, or undefined if that is not decided yet.
   *
   * The running server's own record wins over the stored one. What is stored is
   * where the allocator last INTENDED to listen; two processes starting at once
   * both allocate before either has bound, so the loser would otherwise dial a
   * port nothing is on.
   */
  async endpoint(): Promise<Endpoint | undefined> {
    const live = await this.postmaster().runningPort();
    const port = live ?? this.store.readPorts()["database"];
    return port === undefined ? undefined : { host: HOST, port };
  }

  /**
   * Everything needed to connect, or undefined if this was never installed.
   *
   * Purely a read — the port and the logins were both decided by `install()`.
   * Undefined when either is missing, because half a set of credentials is not
   * usable and pretending otherwise produces an authentication failure several
   * steps later instead of "nothing is installed here".
   */
  async credentials(): Promise<DbCredentials | undefined> {
    const logins = this.store.readDatabaseLogins();
    if (logins === undefined) return undefined;

    const where = await this.endpoint();
    if (where === undefined) return undefined;

    return { ...where, database: this.config.databaseName, logins };
  }

  async status(): Promise<DatastoreState> {
    // Two nouns, one answer: no cluster is a different state from a cluster
    // whose server is down, and a caller has to be able to tell them apart.
    if (!(await this.cluster().exists())) return "uninitialised";
    return (await this.postmaster().isRunning()) ? "running" : "stopped";
  }

  /**
   * Bring the datastore into existence and make it usable. Idempotent.
   *
   * The order IS the content of this method, and every step is a fact about
   * PostgreSQL rather than about any application — which is why it lives here
   * and not in the caller.
   */
  async install(schema: SchemaDefinition): Promise<void> {
    if (!(await this.cluster().exists())) {
      // The two decisions, made here because this is the only member allowed to
      // make them. The port is baked into postgresql.conf by `create()`, and
      // `initdb` needs the superuser password before any SQL can run at all —
      // so both must exist before the cluster does, and neither can be deferred
      // to whoever first wants to connect.
      const port = await this.ports().allocate("database");
      const { superuser } = this.decideLogins();

      try {
        await this.cluster().create({ superuser, host: HOST, port });
      } catch (error) {
        // Another process may have created it while we were trying to.
        if (!(await this.cluster().exists())) throw error;
      }
    }

    // start() includes waiting until the server answers, which has to happen
    // before anything connects.
    await this.start();

    const databases = this.databases();
    const name = this.config.databaseName;
    await databases.create(name);
    await databases.migrate(name, await schema.migrations());

    // The migrations create the runtime role but cannot set its password —
    // migration files are committed and secrets are not.
    const { app } = this.decideLogins();
    await databases.setRolePassword(name, app.user, app.password);
  }

  /**
   * Start the datastore and wait until it will actually answer.
   *
   * Creates nothing; fails if it was never installed. Safe for any caller,
   * including one that merely wants to read: starting resumes something that
   * already exists, so the decision to have a datastore was made earlier by
   * somebody else.
   *
   * THE WAIT IS PART OF STARTING, not an extra step callers must remember.
   * `pg_ctl -w` returns when the postmaster is up, and with TCP the port is
   * bound before recovery finishes — so a process that lost the start race can
   * connect to an open port and be told "the database system is starting up"
   * (57P03). Leaving that to the caller meant six racing processes and two of
   * them failing.
   */
  async start(): Promise<void> {
    await this.postmaster().start();
    await this.databases().waitUntilAccepting();
  }

  async stop(): Promise<boolean> {
    return this.postmaster().stop();
  }

  /**
   * Is anything actually answering on this profile's port?
   *
   * The only check that does not go through postmaster.pid — which `status()`
   * does, and which reports "not running" for a live server whose data
   * directory was deleted. Anything about to DESTROY the profile needs evidence
   * rather than a pid file's word.
   */
  async isServing(): Promise<boolean> {
    // Both sources, because they disagree in exactly the case this exists for:
    // postmaster.pid names the port when it survives, and the config records
    // what the allocator last chose when it does not.
    const fromPidFile = await this.postmaster().runningPort();
    const recorded = this.store.readPorts()["database"];

    for (const port of new Set([fromPidFile, recorded])) {
      if (port !== undefined && (await this.postmaster().isAnswering(HOST, port))) return true;
    }
    return false;
  }

  async describe(): Promise<string> {
    const state = await this.status();
    const where = this.config.displayPath(this.dataDir());
    if (state === "running") return `PostgreSQL ${PG_MAJOR} running at ${where}`;
    if (state === "stopped") return `PostgreSQL ${PG_MAJOR} stopped at ${where}`;
    return `No datastore yet — run \`${this.config.identity.name} init\``;
  }
}
