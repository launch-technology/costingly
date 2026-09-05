/**
 * The platform's datastore: one profile's database, and how to reach it.
 *
 * A datastore is what an application actually has — somewhere its data lives,
 * that it can provision, start, stop and connect to. That it is PostgreSQL is
 * an implementation detail this file owns and nothing above it needs to know.
 *
 * WHY THIS IS NOT UNDER postgres/
 *
 * Everything in `platform/postgres/` is deliberately ignorant of profiles and
 * config files — it is handed a directory and a port and drives PostgreSQL
 * against them. This file is the one place that decides WHICH directory and
 * WHICH port, which means it is the one place that needs a `PlatformConfig` and
 * a `ConfigStore`. Keeping it here is what lets `postgres/` be lifted into
 * another project whole.
 *
 * WHAT IT REALLY OWNS: THE DECISIONS, AND REMEMBERING THEM
 *
 * The paths are computed. The port and the credentials are not — they are
 * decided once and stored, because every process has to agree. Two processes
 * that each allocated a port would start two servers or collide on the data
 * directory lock; two that each generated a superuser password would leave the
 * second unable to authenticate against the cluster the first created.
 *
 * The operations are forwarded rather than reimplemented. Holding the identity
 * is what makes this the only thing that can construct a working service.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ConfigStore, DatabaseLogins } from "../../config-store.js";
import type { PlatformConfig } from "../../platform-config.js";
import type { PortService } from "../../port-allocator.js";
import { ROLE_APP, ROLE_SUPERUSER, type DbCredentials } from "../../postgres/credentials.js";
import type { Datastore, DatastoreState } from "../types/datastore.js";
import { OsService } from "../../services/os-service.js";
import { PG_MAJOR, PgBinariesService } from "../../postgres/services/pg-binaries-service.js";
import { PgClusterService } from "../../postgres/services/pg-cluster-service.js";
import { PgServerService } from "../../postgres/services/pg-server-service.js";

/** Loopback only. Never 0.0.0.0 — that would put the data on the network. */
const HOST = "127.0.0.1";

/** 24 random bytes. Long enough that nothing is gained by making it longer. */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

export function createDatastore(
  config: PlatformConfig,
  store: ConfigStore,
  ports: () => PortService,
): Datastore {
  const dataDir = (): string => join(config.profileDir(), `pg${PG_MAJOR}`);
  const logPath = (): string => `${dataDir()}.log`;

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
   */
  // One per composition: the binaries are the same for every cluster, and the
  // OS service holds nothing per-call.
  const binaries = new PgBinariesService(new OsService());

  const cluster = (): PgClusterService => new PgClusterService(dataDir(), binaries);
  const postmaster = (): PgServerService =>
    new PgServerService(dataDir(), logPath(), binaries);

  const api: Datastore = {
    dataDir,
    logPath,

    /**
     * The port is allocated only when the server is NOT already running. A
     * running postmaster holds its port legitimately; probing would find it
     * taken, step to the next one, and start a second server that then fails on
     * the data directory lock. `status()` reads postmaster.pid and needs no
     * port, so it is safe to ask before one exists.
     */
    credentials: async (): Promise<DbCredentials> => {
      const live = await postmaster().runningPort();
      const port = live ?? (await ports().allocate("database"));
      return { host: HOST, port, database: config.databaseName, logins: logins() };
    },

    endpoint: async (): Promise<{ host: string; port: number } | undefined> => {
      const live = await postmaster().runningPort();
      const port = live ?? store.readPorts()["database"];
      return port === undefined ? undefined : { host: HOST, port };
    },

    recordedCredentials: async (): Promise<DbCredentials | undefined> => {
      const stored = store.readDatabaseLogins();
      if (stored === undefined) return undefined;

      const where = await postmaster().runningPort();
      const port = where ?? store.readPorts()["database"];
      if (port === undefined) return undefined;

      return { host: HOST, port, database: config.databaseName, logins: stored };
    },

    status: async (): Promise<DatastoreState> => {
      // Two nouns, one answer: no cluster is a different state from a cluster
      // whose server is down, and a caller has to be able to tell them apart.
      if (!(await cluster().exists())) return "uninitialised";
      return (await postmaster().isRunning()) ? "running" : "stopped";
    },

    stop: () => postmaster().stop(),

    provision: async (): Promise<void> => {
      if (await cluster().exists()) return;

      const port = await ports().allocate("database");
      try {
        await cluster().create({ superuser: logins().superuser, host: HOST, port });
      } catch (error) {
        // Another process may have created it while we were trying to.
        if (!(await cluster().exists())) throw error;
      }
    },

    start: () => postmaster().start(),

    isServing: async (): Promise<boolean> => {
      // Both sources, because they disagree in exactly the case this exists
      // for: postmaster.pid names the port when it survives, and the config
      // records what the allocator last chose when it does not.
      const fromPidFile = await postmaster().runningPort();
      const recorded = store.readPorts()["database"];

      for (const port of new Set([fromPidFile, recorded])) {
        if (port !== undefined && (await postmaster().isAnswering(HOST, port))) return true;
      }
      return false;
    },


    describe: async (): Promise<string> => {
      const state = await api.status();
      const where = config.displayPath(dataDir());
      if (state === "running") return `PostgreSQL ${PG_MAJOR} running at ${where}`;
      if (state === "stopped") return `PostgreSQL ${PG_MAJOR} stopped at ${where}`;
      return `No database yet — run \`${config.identity.name} init\``;
    },
  };

  return api;
}
