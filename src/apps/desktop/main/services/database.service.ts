/**
 * The app's hold on the database: its lifetime, its controls, and what went
 * wrong the last time something was asked of it.
 *
 * On a machine that has a database, the app brings it up on launch and stops
 * it on quit, so nothing of costingly runs while the app does not. Between
 * those, the user can start, stop and restart it from the status screen.
 *
 * TELLING FAILURES APART WITHOUT ASKING THE DATABASE TO
 *
 * The layers underneath report a failure as a message, not a kind. So this
 * service does the work in two steps and notes which one failed:
 *
 *   1. start     a failure here is the server: it would not start, or
 *                something else has its port.
 *   2. update    a failure here is the schema: the server is up, and bringing
 *                its tables up to date did not work.
 *
 * A failed start is then narrowed with evidence gathered at the time — is the
 * server in fact running; is something answering on its port; did the log
 * WRITTEN DURING THIS ATTEMPT say the port could not be bound. Only what was
 * written during the attempt counts: the log is appended to for ever, and last
 * week's port conflict must not label today's different failure.
 *
 * ONE THING AT A TIME
 *
 * Every operation goes through one queue, including the stop at quit. A quit
 * that arrives while a start is in progress waits for it and then stops what
 * it started; without the queue the app could exit and leave the database
 * running behind it.
 *
 * NOTHING HERE THROWS. A database that will not start must not stop the app
 * from opening — the status screen is where the user finds out, and it cannot
 * say so from a process that exited. Failures are remembered and reported.
 */

import type { DatastoreState, Endpoint } from "../../../../platform/datastore/datastore.js";

/** What went wrong, as far as the evidence shows. */
export type DatabaseFailure =
  | { kind: "will-not-start"; reason: string }
  | { kind: "port-in-use"; reason: string; port: number | undefined }
  | { kind: "not-answering"; reason: string }
  | { kind: "update-failed"; reason: string }
  | { kind: "create-failed"; reason: string };

export interface DatabaseDependencies {
  datastore: {
    status(): Promise<DatastoreState>;
    start(): Promise<void>;
    stop(): Promise<boolean>;
    /** Is anything answering on this profile's port — ours or not. */
    isServing(): Promise<boolean>;
    endpoint(): Promise<Endpoint | undefined>;
  };
  /** Bring an existing database's tables up to date. Idempotent. */
  update(): Promise<void>;
  /** Create the database where there is none, and bring it up. Idempotent. */
  create(): Promise<void>;
  log: {
    /** How much has been written to the database's log so far. */
    size(): Promise<number>;
    /** What has been written since that point. */
    readSince(offset: number): Promise<string>;
  };
  /** Close this process's own connections to the database. */
  closeConnections(): Promise<void>;
  /**
   * Are the Plaid keys in place? The tables are only updated on a machine that
   * is fully set up: the update also makes sure an encryption key exists, and
   * that must not happen quietly on a machine setup has not finished with.
   */
  keysPresent(): boolean;
  /** A safe one-line-or-so description of any error, with secrets removed. */
  describeError(error: unknown): string;
  report(line: string): void;
}

export class DatabaseService {
  private failure: DatabaseFailure | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DatabaseDependencies) {}

  /** The failure left by the most recent operation, or undefined after a success. */
  lastFailure(): DatabaseFailure | undefined {
    return this.failure;
  }

  /**
   * At launch: start a database that exists and bring its tables up to date.
   * A machine with no database is left alone — that is setup's to create.
   */
  bringUp(): Promise<void> {
    return this.enqueue(() => this.up());
  }

  /** The Start button. The same as launch: up, and up to date. */
  start(): Promise<void> {
    return this.enqueue(() => this.up());
  }

  /** The Retry button after a failed update. The server is already running. */
  update(): Promise<void> {
    return this.enqueue(() => this.up());
  }

  /** The Stop button, and quit. Not a failure: stopped is a state, not a fault. */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      await this.down();
      this.failure = undefined;
    });
  }

  restart(): Promise<void> {
    return this.enqueue(async () => {
      await this.down();
      await this.up();
    });
  }

  /**
   * Create the database on a machine that has none, and report what stopped it
   * if anything did. Used by setup and by the status screen alike.
   */
  create(): Promise<DatabaseFailure | undefined> {
    return this.enqueue(async () => {
      const mark = await this.logSize();
      try {
        await this.deps.create();
        this.failure = undefined;
      } catch (error) {
        this.failure = await this.classifyCreate(error, mark);
        this.deps.report(`the database was not created (${this.failure.kind}): ${this.failure.reason}`);
      }
    }).then(() => this.failure);
  }

  // -------------------------------------------------------------------------

  private async up(): Promise<void> {
    let state: DatastoreState;
    try {
      state = await this.deps.datastore.status();
    } catch (error) {
      this.fail({ kind: "will-not-start", reason: this.deps.describeError(error) });
      return;
    }
    if (state === "uninitialised") {
      this.failure = undefined;
      return;
    }

    const mark = await this.logSize();
    try {
      await this.deps.datastore.start();
    } catch (error) {
      this.fail(await this.classifyStart(error, mark));
      return;
    }

    if (this.deps.keysPresent()) {
      try {
        await this.deps.update();
      } catch (error) {
        this.fail({ kind: "update-failed", reason: this.deps.describeError(error) });
        return;
      }
    }

    this.failure = undefined;
  }

  private async down(): Promise<void> {
    try {
      // Ours first: a pooled connection that outlives the server hands a dead
      // socket to the next caller.
      await this.deps.closeConnections();
      if ((await this.deps.datastore.status()) === "running") await this.deps.datastore.stop();
    } catch (error) {
      this.deps.report(`the database did not stop: ${this.deps.describeError(error)}`);
    }
  }

  /**
   * Why did the start fail? Evidence first, most specific first.
   */
  private async classifyStart(error: unknown, logMark: number): Promise<DatabaseFailure> {
    const reason = this.deps.describeError(error);
    const { datastore } = this.deps;

    // "Start" also waits for the server to accept a login. If the server came
    // up and that wait failed, it did start — it is not answering.
    const state = await datastore.status().catch((): DatastoreState => "stopped");
    if (state === "running") return { kind: "not-answering", reason };

    // Two independent signs of a port conflict. Something answering on our
    // port while our server is down is one. The server's own complaint that it
    // could not bind — in what it wrote during THIS attempt — is the other.
    const written = await this.deps.log.readSince(logMark).catch(() => "");
    const answering = await datastore.isServing().catch(() => false);
    if (answering || /could not bind/i.test(written)) {
      const where = await datastore.endpoint().catch(() => undefined);
      return { kind: "port-in-use", reason, port: where?.port };
    }

    return { kind: "will-not-start", reason };
  }

  /** Creating is install: it can fail before a cluster exists, at start, or after. */
  private async classifyCreate(error: unknown, logMark: number): Promise<DatabaseFailure> {
    const state = await this.deps.datastore.status().catch((): DatastoreState => "uninitialised");
    if (state === "uninitialised") {
      return { kind: "create-failed", reason: this.deps.describeError(error) };
    }
    if (state === "running") {
      return { kind: "update-failed", reason: this.deps.describeError(error) };
    }
    return this.classifyStart(error, logMark);
  }

  private fail(failure: DatabaseFailure): void {
    this.failure = failure;
    this.deps.report(`the database is not usable (${failure.kind}): ${failure.reason}`);
  }

  private logSize(): Promise<number> {
    return this.deps.log.size().catch(() => 0);
  }

  /** Run after whatever is already running. An operation never rejects the queue. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation).catch((error: unknown) => {
      this.deps.report(`a database operation failed unexpectedly: ${this.deps.describeError(error)}`);
    });
    this.queue = run;
    return run;
  }
}
