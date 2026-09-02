/**
 * A project's local PostgreSQL cluster.
 *
 * The lifecycle itself — initdb, pg_ctl, config generation — lives in
 * `cluster.ts`, which knows nothing about profiles or config files. This file is
 * the binding: it decides *where* the cluster goes, what port it listens on and
 * which credentials it uses, then hands those down as plain values.
 *
 * Everything project-specific arrives through `PlatformConfig` and the store it
 * is handed. Nothing here names a project.
 *
 * Real Postgres binaries (PostgreSQL 18) ship as an ordinary npm dependency. No
 * Docker, nothing for the user to install, and real MVCC — so a sync, a CLI read
 * and a long-lived server can all touch the database at the same time.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ConfigStore, DatabaseLogins } from "../config-store.js";
import type { PlatformConfig } from "../platform-config.js";
import type { PortService } from "../port-allocator.js";
import { ROLE_APP, ROLE_SUPERUSER, type DbCredentials } from "./credentials.js";
import { PG_MAJOR, PostgresCluster, type ClusterConfig } from "./cluster.js";

export type { ServerState } from "./cluster.js";

/** Loopback only. Never 0.0.0.0 — that would put the data on the network. */
const HOST = "127.0.0.1";

/** 24 random bytes. Long enough that nothing is gained by making it longer. */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Everything a project needs from its cluster, bound to one profile. */
export interface PostgresServer {
  /**
   * The cluster directory (PGDATA).
   *
   * Always inside the profile, never configurable separately. A second lever
   * for "put the database somewhere else" would let the config and the cluster
   * drift into different places — which is exactly how a sandbox config once
   * ended up sharing a database with a production one, under a different
   * encryption key. To move the database, move the whole profile.
   *
   * The major version is in the name because a data directory belongs to
   * exactly one: a future upgrade creates a new cluster beside the old one
   * rather than failing with an error about `PG_VERSION`.
   */
  clusterDir(): string;

  /** Postmaster log. `pg_ctl start` redirects both stdout and stderr here. */
  logPath(): string;

  /** Everything needed to connect, as either identity. */
  credentials(): Promise<DbCredentials>;

  status(): ReturnType<PostgresCluster["status"]>;
  stop(): Promise<boolean>;
  ensureRunning(): Promise<void>;

  /** Human-readable summary, for status output. */
  describe(): Promise<string>;
}

export function createPostgresServer(
  config: PlatformConfig,
  store: ConfigStore,
  ports: () => PortService,
): PostgresServer {
  const clusterDir = (): string => join(config.profileDir(), `pg${PG_MAJOR}`);
  const logPath = (): string => `${clusterDir()}.log`;

  /**
   * The database logins, generating and storing them on first use.
   *
   * Generated here rather than by a migration because `initdb` needs the
   * superuser password before any SQL can run at all. Both are written before
   * the cluster is created, so a crash midway leaves stored credentials that
   * match a cluster which does not exist yet — recoverable — rather than a
   * cluster nothing holds the password for.
   */
  const logins = (): DatabaseLogins => {
    const existing = store.readDatabaseLogins();
    if (existing !== undefined) return existing;

    const created: DatabaseLogins = {
      superuser: { user: ROLE_SUPERUSER, password: generatePassword() },
      app: { user: ROLE_APP, password: generatePassword() },
    };
    store.writeDatabaseLogins(created);
    return created;
  };

  /**
   * Built fresh on every call, never cached.
   *
   * `config.profileDir()` reads the home variable at call time, and the test
   * suite changes it between assertions. A cached instance would answer for
   * whichever profile happened to be active first — the kind of bug that only
   * shows up as one suite quietly reading another suite's database.
   *
   * `status` and `stop` work from PGDATA alone, so they pass port 0: the value
   * is never used and inventing one would imply a choice not yet made.
   */
  const clusterConfig = (port: number): ClusterConfig => ({
    dataDir: clusterDir(),
    databaseName: config.databaseName,
    logPath: logPath(),
    host: HOST,
    port,
    superuser: logins().superuser,
  });

  return {
    clusterDir,
    logPath,

    /**
     * The port is allocated only when the server is NOT already running. A
     * running postmaster holds its port legitimately; probing would find it
     * taken, step to the next one, and start a second server that then fails on
     * the data directory lock. `status()` reads postmaster.pid and needs no
     * port, so it is safe to ask before one exists.
     */
    credentials: async (): Promise<DbCredentials> => {
      const live = await new PostgresCluster(clusterConfig(0)).runningPort();
      const port = live ?? (await ports().allocate("database"));
      return { host: HOST, port, database: config.databaseName, logins: logins() };
    },

    status: () => new PostgresCluster(clusterConfig(0)).status(),
    stop: () => new PostgresCluster(clusterConfig(0)).stop(),

    ensureRunning: async (): Promise<void> => {
      const live = await new PostgresCluster(clusterConfig(0)).runningPort();
      const port = live ?? (await ports().allocate("database"));
      return new PostgresCluster(clusterConfig(port)).ensureRunning();
    },

    describe: async (): Promise<string> => {
      const state = await new PostgresCluster(clusterConfig(0)).status();
      const where = config.displayPath(clusterDir());
      if (state === "running") return `PostgreSQL ${PG_MAJOR} running at ${where}`;
      if (state === "stopped") return `PostgreSQL ${PG_MAJOR} stopped at ${where}`;
      return `No database yet — run \`${config.identity.name} init\``;
    },
  };
}
