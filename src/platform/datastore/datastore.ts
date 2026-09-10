/**
 * A datastore: somewhere an application's data lives, and how to reach it.
 *
 * The contract the domain is written against. It says nothing about what backs
 * the datastore — PostgreSQL today — so the code above it never learns which
 * database engine it is talking to, and `platform/postgres/` never learns that
 * profiles exist.
 *
 * IT DOES ASSUME A MANAGED, SERVER-BACKED DATASTORE. `install`, `start`,
 * `stop` and `isServing` only mean something for a datastore this application
 * installs and runs itself. That is deliberate rather than an oversight: the
 * whole point is that no user installs a database, so lifecycle is part of the
 * contract. An embedded, file-backed store would need a narrower one.
 *
 * The implementation is in ../services/datastore-service.ts, which binds one
 * profile's identity to these operations.
 */

import type { DbCredentials } from "../postgres/credentials.js";
import type { Migration } from "../postgres/migrations.js";

/**
 * What an application says its datastore's schema should look like.
 *
 * The MECHANISM for applying these belongs to the datastore; the CONTENT does
 * not, which is why they arrive as a definition rather than being read from a
 * folder the platform picks.
 */
export interface SchemaDefinition {
  /** Every migration, in the order they must be applied. */
  migrations(): Promise<Migration[]>;
}

/** Cluster absent, or present with the server up or down. */
export type DatastoreState = "running" | "stopped" | "uninitialised";

/** Where a datastore accepts connections. */
export interface Endpoint {
  host: string;
  port: number;
}

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
   * Everything needed to connect, or undefined if this was never installed.
   *
   * A READ. It does not allocate a port, generate a password or write anything —
   * those decisions belong to `install()`, which is the only member entitled to
   * make them.
   *
   * There used to be two of these: one that read and one that decided, with the
   * deciding one holding the friendlier name. Callers that only wanted to look
   * reached for it and quietly created half a profile, which is how a status
   * report came to resurrect a profile that had just been deleted.
   *
   * `undefined` means not installed, and that is an answer rather than a gap to
   * fill.
   */
  credentials(): Promise<DbCredentials | undefined>;

  /**
   * Where this datastore listens, or undefined if that is not decided yet.
   *
   * A live server's own record of its port wins over the stored one: what was
   * stored is where the allocator last intended to listen, which is not
   * necessarily where a server that has been up for weeks actually is.
   */
  endpoint(): Promise<Endpoint | undefined>;

  /** Cluster absent, or present with its server up or down. */
  status(): Promise<DatastoreState>;

  /** Ask the server to shut down. True if one was running. */
  stop(): Promise<boolean>;

  /**
   * Bring the datastore into existence and make it usable. Idempotent.
   *
   * THE ONLY MEMBER THAT CREATES ANYTHING. Everything it does — creating the
   * store, starting it, waiting for it to answer, applying the schema, giving
   * the runtime identity its password — happens here or not at all.
   *
   * One operation rather than several, because the ORDER is knowledge of
   * whatever backs the datastore, not of the application: a caller sequencing
   * these itself would have to know that a bound port is not a ready server,
   * and that a database cannot be created from inside itself. Neither is true
   * of datastores in general.
   */
  install(schema: SchemaDefinition): Promise<void>;

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
}
