/**
 * The app owns the database's lifetime.
 *
 * On a machine that has a database, the app starts it on the way up and stops
 * it on the way down, so nothing of costingly runs while the app does not.
 *
 * Starting uses the datastore's `start()`, which cannot create anything — a
 * machine with no database gets the setup screen, not a database it never
 * asked for.
 *
 * NEITHER METHOD THROWS. A database that will not start must not stop the app
 * from opening: the status screen is where the user finds out, and it cannot
 * say so from a process that exited. A database that will not stop must not
 * stop the app from quitting.
 */

import type { DatastoreState } from "../../../../platform/datastore/datastore.js";

/** The part of a datastore this service drives. */
export interface ManagedDatastore {
  status(): Promise<DatastoreState>;
  start(): Promise<void>;
  stop(): Promise<boolean>;
}

export class DatabaseLifetimeService {
  constructor(
    private readonly datastore: ManagedDatastore,
    private readonly log: (line: string) => void,
  ) {}

  /** Bring up a database that already exists. A machine with none is left alone. */
  async start(): Promise<void> {
    try {
      if ((await this.datastore.status()) !== "uninitialised") await this.datastore.start();
    } catch (error) {
      this.log(`the database did not start: ${message(error)}`);
    }
  }

  /** Stop the database if one is running. */
  async stop(): Promise<void> {
    try {
      if ((await this.datastore.status()) === "running") await this.datastore.stop();
    } catch (error) {
      this.log(`the database did not stop: ${message(error)}`);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
