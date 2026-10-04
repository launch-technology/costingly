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
 * adds nothing; the domain's own functions are handed over as they are, bound
 * to the app's one Plaid client where they need one. Where the domain needs
 * adapting rather than passing along — the Plaid key check, the database log —
 * that has its own file beside this one.
 *
 * No Electron: the suite builds the same services from these in plain node.
 */

import { existsSync } from "node:fs";

import {
  describeConfig,
  getSecretIfSet,
  readConfigFile,
  writeConfig,
} from "../../../../domain/config.js";
import { generateEncryptionKey } from "../../../../domain/crypto.js";
import { closeDb } from "../../../../domain/data/default-database.js";
import { plaid } from "../../../../domain/data/default-plaid.js";
import {
  describeError as describeDomainError,
  PlaidClient,
} from "../../../../domain/data/plaid.client.js";
import { configStore, platform, server } from "../../../../domain/project.js";
import { createLinkToken } from "../../../../domain/services/banks/link.service.js";
import { checkDatabase } from "../../../../domain/services/database/database-health.service.js";
import { install } from "../../../../domain/services/install.service.js";
import { checkPlaid, checkProfile } from "../../../../domain/services/status.service.js";
import type { StatusChecks } from "../controllers/status.controller.js";
import type { DatabaseDependencies } from "../services/database.service.js";
import type { SetupDependencies } from "../services/setup.service.js";
import { DatabaseLog, createRedactor } from "./database-log.js";
import { PlaidKeyVerifier } from "./plaid-key-verifier.js";

/** This profile: where it is, and how its paths are shown. */
export const profile = platform;

/**
 * Remove this profile's secrets from text about to be shown.
 *
 * Asked for the secrets every time it runs: the database's passwords do not
 * exist until setup creates them, which is after the app has started.
 */
export const redact = createRedactor(() => {
  const logins = configStore.readDatabaseLogins();
  return [
    getSecretIfSet("plaidSecret"),
    getSecretIfSet("encryptionKey"),
    logins?.superuser.password,
    logins?.app.password,
  ];
});

/** A safe description of any error: no error object, and no secrets. */
export function describeError(error: unknown): string {
  return redact(describeDomainError(error));
}

/** The database's own log, redacted on the way out. */
export const databaseLog = new DatabaseLog({
  path: () => server.logPath(),
  displayPath: (path) => platform.displayPath(path),
  redact,
});

/** Are both Plaid keys in place — from the environment or the config file? */
export function keysPresent(): boolean {
  const sources = new Map(describeConfig().map((value) => [value.key, value.source]));
  return sources.get("plaidClientId") !== "missing" && sources.get("plaidSecret") !== "missing";
}

/** What the status screen's Database section is read from. */
export const databaseSources = {
  health: checkDatabase,
  state: () => server.status(),
};

export function statusChecks(): StatusChecks {
  return { profile: checkProfile, plaid: () => checkPlaid(plaid) };
}

/**
 * The check a pair of typed keys must pass before setup saves it: ask Plaid
 * for a link token with a client built from that pair alone.
 *
 * Production, like everything the app does with Plaid. There is no way to
 * point this elsewhere from outside; the suites that need Plaid's sandbox
 * build their own verifier around their own check.
 */
export function keyCheck(clientId: string, secret: string): Promise<string> {
  return createLinkToken(PlaidClient.withKeys(clientId, secret));
}

export function databaseDependencies(report: (line: string) => void): DatabaseDependencies {
  return {
    datastore: server,
    // One domain operation does both: it creates what is missing and brings
    // what exists up to date. Which of the two it is being asked for is the
    // database service's distinction, made by when it calls.
    update: install,
    create: install,
    log: databaseLog,
    closeConnections: closeDb,
    keysPresent,
    describeError,
    report,
  };
}

/** Everything setup needs except creating the database, which the app supplies. */
export function setupDependencies(): Omit<SetupDependencies, "createDatabase"> {
  return {
    datastore: server,
    keysPresent,
    config: {
      readFile: readConfigFile,
      write: writeConfig,
    },
    keys: new PlaidKeyVerifier({ check: keyCheck }),
    newEncryptionKey: generateEncryptionKey,
    dataFolder: () => platform.displayPath(platform.profileDir()),
    pathExists: existsSync,
    describeError,
  };
}
