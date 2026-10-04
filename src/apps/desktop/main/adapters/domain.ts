/**
 * Everything the desktop app uses from costingly's domain, in one place.
 *
 * The services and controllers above this are written against small
 * interfaces of their own and import no domain code. This file is where those
 * interfaces are filled with the real thing — so "what does the desktop app
 * depend on underneath?" is answered by reading one file, and when a later
 * story moves or renames something in the domain, this is the file that
 * changes.
 *
 * WIRING ONLY. Nothing here wraps a domain function in another function that
 * adds nothing; the domain's own functions are handed over as they are. The
 * one place the domain needs adapting rather than passing along is the Plaid
 * key check, and that has its own file.
 *
 * No Electron: the suite builds the same services from these in plain node.
 */

import { existsSync } from "node:fs";

import { describeConfig, get, readConfigFile, writeConfig } from "../../../../domain/config.js";
import { generateEncryptionKey } from "../../../../domain/crypto.js";
import { closeDb } from "../../../../domain/data/default-database.js";
import { describeError } from "../../../../domain/data/plaid.client.js";
import { platform, server } from "../../../../domain/project.js";
import { createLinkToken } from "../../../../domain/services/banks/link.service.js";
import { checkDatabase } from "../../../../domain/services/database/database-health.service.js";
import { install } from "../../../../domain/services/install.service.js";
import { checkPlaid, checkProfile } from "../../../../domain/services/status.service.js";
import type { StatusChecks } from "../controllers/status.controller.js";
import type { ManagedDatastore } from "../services/database-lifetime.service.js";
import type { SetupDependencies } from "../services/setup.service.js";
import { PlaidKeyVerifier } from "./plaid-key-verifier.js";

/** This profile: where it is, and how its paths are shown. */
export const profile = platform;

/** This profile's datastore, for the service that starts and stops it. */
export const datastore: ManagedDatastore = server;

/** Close this process's database connections. Does not stop the server. */
export const closeConnections = closeDb;

export { describeError };

export function statusChecks(): StatusChecks {
  return { profile: checkProfile, database: checkDatabase, plaid: checkPlaid };
}

export function setupDependencies(): SetupDependencies {
  return {
    datastore: server,
    config: {
      describe: describeConfig,
      readFile: readConfigFile,
      write: writeConfig,
      plaidEnv: () => get("plaidEnv"),
    },
    keys: new PlaidKeyVerifier({ check: createLinkToken }),
    install,
    newEncryptionKey: generateEncryptionKey,
    dataFolder: () => platform.displayPath(platform.profileDir()),
    pathExists: existsSync,
    describeError,
  };
}
