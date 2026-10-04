/**
 * The database's controls: start, stop, restart, update, create — and the end
 * of its log, for when one of them fails.
 *
 * Every action answers with the Database section AS IT IS AFTERWARDS. So the
 * window needs no second call to learn what happened, and a failure is never a
 * rejected call: it comes back as a section that says what went wrong and
 * which button addresses it.
 */

import type { DatabaseHealth } from "../../../../domain/services/database/database-health.service.js";
import type { DatastoreState } from "../../../../platform/datastore/datastore.js";
import type { DatabaseSectionView, LogExcerpt } from "../../bridge/contract.js";
import { presentDatabaseSection, presentStartFailure } from "../presenters/database.presenter.js";
import { couldNotCheck } from "../presenters/status.presenter.js";
import type { DatabaseService } from "../services/database.service.js";
import type { Controller, HandlersFor } from "./controller.js";

/** Reads the Database section as it is right now. Never throws. */
export type DatabaseSectionReader = () => Promise<DatabaseSectionView>;

export interface DatabaseSectionSources {
  /** The full health check: server state, a login, and the schema. */
  health(): Promise<DatabaseHealth>;
  /** Only whether the server is up. Reads a pid file; never touches the port. */
  state(): Promise<DatastoreState>;
}

/**
 * The Database section is two things put together: a live health check, and
 * the failure the service remembers from the last thing it was asked to do.
 * The status screen and every action here need exactly that, so it is built
 * once and handed to both controllers.
 *
 * WHEN THE START IS KNOWN TO HAVE FAILED, THE HEALTH CHECK IS SKIPPED. It
 * would try to log in to whatever is on the database's port — and in a port
 * conflict that is another program, which may accept the connection and never
 * answer. The check waits fifteen seconds for that; the user would wait
 * fifteen seconds to be told what the app already knows. Asking only whether
 * the server is up is enough to confirm the failure still stands.
 */
export function databaseSectionReader(
  sources: DatabaseSectionSources,
  database: Pick<DatabaseService, "lastFailure">,
): DatabaseSectionReader {
  return async () => {
    try {
      const failure = database.lastFailure();
      if (
        (failure?.kind === "will-not-start" || failure?.kind === "port-in-use") &&
        (await sources.state()) === "stopped"
      ) {
        return presentStartFailure(failure);
      }
      return presentDatabaseSection(await sources.health(), failure);
    } catch (error) {
      // The health check promises not to throw. If it does anyway, the answer
      // is a section that says so, with nothing to press.
      return { ...couldNotCheck(error), actions: [] };
    }
  };
}

export class DatabaseController implements Controller<"database"> {
  constructor(
    private readonly database: DatabaseService,
    private readonly section: DatabaseSectionReader,
    private readonly log: { excerpt(): Promise<LogExcerpt> },
  ) {}

  handlers(): HandlersFor<"database"> {
    return {
      "database.start": () => this.then(this.database.start()),
      "database.stop": () => this.then(this.database.stop()),
      "database.restart": () => this.then(this.database.restart()),
      "database.update": () => this.then(this.database.update()),
      "database.create": () => this.then(this.database.create()),
      "database.logExcerpt": () => this.log.excerpt(),
    };
  }

  private async then(action: Promise<unknown>): Promise<DatabaseSectionView> {
    await action;
    return this.section();
  }
}
