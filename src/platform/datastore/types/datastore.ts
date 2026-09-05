/**
 * A datastore: somewhere an application's data lives, and how to reach it.
 *
 * The contract the domain is written against. It says nothing about what backs
 * the datastore — PostgreSQL today — so the code above it never learns which
 * database engine it is talking to, and `platform/postgres/` never learns that
 * profiles exist.
 *
 * IT DOES ASSUME A MANAGED, SERVER-BACKED DATASTORE. `provision`, `start`,
 * `stop` and `isServing` only mean something for a datastore this application
 * installs and runs itself. That is deliberate rather than an oversight: the
 * whole point is that no user installs a database, so lifecycle is part of the
 * contract. An embedded, file-backed store would need a narrower one.
 *
 * The implementation is in ../services/datastore-service.ts, which binds one
 * profile's identity to these operations.
 */

import type { DbCredentials } from "../../postgres/credentials.js";

/** Cluster absent, or present with the server up or down. */
export type DatastoreState = "running" | "stopped" | "uninitialised";

/** Everything a project needs from its cluster, bound to one profile. */
export interface Datastore {
  /**
   * Where the datastore keeps its data.
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
  dataDir(): string;

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

  /** Cluster absent, or present with its server up or down. */
  status(): Promise<DatastoreState>;

  /** Ask the server to shut down. True if one was running. */
  stop(): Promise<boolean>;

  /**
   * Create the cluster if it is not there. THE ONLY MEMBER THAT RUNS initdb.
   *
   * Separated from `start()` because they are operations on different things —
   * `initdb` makes a cluster, `pg_ctl start` runs a server against one — and a
   * single function doing both meant every caller that wanted to start a
   * stopped server could create one instead.
   */
  provision(): Promise<void>;

  /**
   * Start the server. Creates nothing; fails if there is no cluster.
   *
   * Safe for any caller, including one that merely wants to read: starting
   * resumes something that already exists, so the data is unchanged and the
   * decision to have a database was made earlier by somebody else.
   */
  start(): Promise<void>;

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
