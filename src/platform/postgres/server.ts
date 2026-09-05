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

/** How long to wait for a connection before calling the port dead. */
const PROBE_TIMEOUT_MS = 1_000;

/**
 * Does anything accept a TCP connection on this port?
 *
 * Deliberately not a Postgres handshake: the question is whether something is
 * holding the port, and a server whose data directory was deleted may fail a
 * handshake while very much still running. Connect, then hang up.
 *
 * A refusal, a timeout, or any error is "no". This decides whether a delete may
 * proceed, so the only answer that stops it is a connection that actually
 * opened.
 */
async function answersOn(port: number): Promise<boolean> {
  const { createConnection } = await import("node:net");

  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: HOST, port });
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
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

  /**
   * Everything needed to connect, as either identity.
   *
   * NOT free of side effects: it allocates a port if none is recorded, and
   * generates and stores the logins if the profile has none. That is correct
   * for anything about to connect, and wrong for anything merely reporting —
   * see `endpoint()`.
   */
  credentials(): Promise<DbCredentials>;

  /**
   * Where this profile listens, if that has already been decided. Never decides.
   *
   * The read-only counterpart to `credentials()`. Returns undefined when no
   * port has been recorded and none is running, which is the honest answer for
   * a profile that has never been used — rather than allocating one and
   * reporting it as though it meant something.
   *
   * A live postmaster's own pid file wins over the recorded value: the recorded
   * port is where the allocator last intended to listen, which is not
   * necessarily where a server that has been running for weeks actually does.
   */
  endpoint(): Promise<{ host: string; port: number } | undefined>;

  /**
   * The connection details this profile has already recorded, or undefined.
   *
   * Same relationship to `credentials()` as `endpoint()` has: identical shape,
   * decides nothing. Undefined means the profile has never been set up — no
   * logins stored, or no port recorded — which is a fact worth reporting rather
   * than a gap worth filling.
   *
   * For inspection only. Anything that intends to USE the database wants
   * `credentials()`, because it is entitled to bring the profile into being.
   */
  recordedCredentials(): Promise<DbCredentials | undefined>;

  status(): ReturnType<PostgresCluster["status"]>;
  stop(): Promise<boolean>;
  ensureRunning(): Promise<void>;

  /**
   * Is anything actually answering on this profile's port?
   *
   * The only check here that does not go through postmaster.pid. `status()` and
   * `stop()` both ask `pg_ctl`, which finds the server through that file and
   * reports "no server running" when it is missing — even while a postmaster is
   * live, which is the state a data directory deleted under a running server
   * leaves behind.
   *
   * So this exists for one caller: anything about to DESTROY the profile, which
   * needs evidence rather than a pid file's word. A bare TCP connect, because
   * the question is "is something there", not "can I log in" — credentials may
   * well be gone by the time this matters.
   *
   * Only the RECORDED port is probed, never a scan. A port nobody wrote down is
   * a port this profile never used.
   */
  isServing(): Promise<boolean>;

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
    // Passed unevaluated. `logins()` GENERATES and stores credentials when the
    // profile has none, so calling it here would make `status()` and `stop()`
    // write to config.json — which is how a read-only diagnostic came to
    // recreate a profile that had just been deleted.
    superuser: () => logins().superuser,
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

    endpoint: async (): Promise<{ host: string; port: number } | undefined> => {
      const live = await new PostgresCluster(clusterConfig(0)).runningPort();
      const port = live ?? store.readPorts()["database"];
      return port === undefined ? undefined : { host: HOST, port };
    },

    recordedCredentials: async (): Promise<DbCredentials | undefined> => {
      const stored = store.readDatabaseLogins();
      if (stored === undefined) return undefined;

      const where = await new PostgresCluster(clusterConfig(0)).runningPort();
      const port = where ?? store.readPorts()["database"];
      if (port === undefined) return undefined;

      return { host: HOST, port, database: config.databaseName, logins: stored };
    },

    status: () => new PostgresCluster(clusterConfig(0)).status(),
    stop: () => new PostgresCluster(clusterConfig(0)).stop(),

    isServing: async (): Promise<boolean> => {
      // Both sources, because they disagree in exactly the case this exists
      // for: postmaster.pid names the port when it survives, and the config
      // records what the allocator last chose when it does not.
      const fromPidFile = await new PostgresCluster(clusterConfig(0)).runningPort();
      const recorded = store.readPorts()["database"];

      for (const port of new Set([fromPidFile, recorded])) {
        if (port !== undefined && (await answersOn(port))) return true;
      }
      return false;
    },

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
