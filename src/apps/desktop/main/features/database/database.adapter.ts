/**
 * The Database section's wiring: the real domain, fitted to what the database
 * service and controller ask for. WIRING ONLY — the domain's install, health
 * check and datastore, handed over as they are. No Electron.
 */

import { closeDb } from "../../../../../domain/data/default-database.js";
import { server } from "../../../../../domain/project.js";
import { checkDatabase } from "../../../../../domain/services/database/database-health.service.js";
import { install } from "../../../../../domain/services/install.service.js";
import { DATABASE_LOG_MAX_BYTES, databaseLog, describeError, keysPresent } from "../../shared/domain.adapter.js";
import type { DatabaseDependencies } from "./database.service.js";

/** What the status screen's Database section is read from. */
export const databaseSources = {
  health: checkDatabase,
  state: () => server.status(),
};

export function databaseDependencies(): DatabaseDependencies {
  return {
    datastore: server,
    // One domain operation does both: it creates what is missing and brings
    // what exists up to date. Which of the two it is being asked for is the
    // database service's distinction, made by when it calls.
    update: install,
    create: install,
    log: {
      size: () => databaseLog.size(),
      readSince: (offset) => databaseLog.readSince(offset),
      trim: () => databaseLog.trim(DATABASE_LOG_MAX_BYTES),
    },
    closeConnections: closeDb,
    keysPresent,
    describeError,
  };
}
