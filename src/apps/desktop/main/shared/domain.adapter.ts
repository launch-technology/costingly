/**
 * The few domain bindings more than one feature uses.
 *
 * Each feature's own wiring is its x.adapter.ts beside it — the file where that
 * feature's small interfaces are filled with the real domain. What sits here is
 * what several of those share: this profile, the app's version, the two logs,
 * the redactor that keeps secrets out of anything shown, and the check for
 * whether the Plaid keys are in place. Only *.adapter.ts files import domain
 * code (enforced by tests/architecture.test.mts); everything else names its
 * types and is handed the real thing by the composition root.
 *
 * WIRING ONLY. Nothing here wraps a domain function in another function that
 * adds nothing; the domain's own functions are handed over as they are. Where
 * the domain needs adapting rather than passing along — the log file — that
 * has its own file beside this one.
 *
 * No Electron: the suite builds the same services from these in plain node.
 */

import { describeConfig, getSecretIfSet } from "../../../../domain/config.js";
import { describeError as describeDomainError } from "../../../../domain/data/plaid.client.js";
import { configStore, platform, server } from "../../../../domain/project.js";
import { packageVersion } from "../../../../platform/package.js";
import { desktopConnectionPath, desktopLogPath } from "../desktop-paths.js";
import { ConnectionFile } from "./connection-file.js";
import { LogFile, createRedactor } from "./log-file.js";

/** This profile: where it is, and how its paths are shown. */
export const profile = platform;

/** costingly's own version, from package.json — not Electron's. */
export const appVersion = packageVersion;

/**
 * How large either log may grow. One file each, trimmed in place; there is no
 * rotation and no history past this. Enough for weeks of ordinary use, and
 * small enough to read and copy without thinking about it.
 */
export const APP_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DATABASE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Where a local MCP client reaches the app: the endpoint's port and token, remembered between runs. */
export const connectionFile = new ConnectionFile(desktopConnectionPath(platform));

/**
 * Remove this profile's secrets from text about to be shown.
 *
 * Asked for the secrets every time it runs: the database's passwords do not
 * exist until setup creates them, which is after the app has started, and the
 * endpoint's token is read or made when the endpoint starts.
 */
export const redact = createRedactor(() => {
  const logins = configStore.readDatabaseLogins();
  return [
    getSecretIfSet("plaidSecret"),
    getSecretIfSet("encryptionKey"),
    logins?.superuser.password,
    logins?.app.password,
    connectionFile.knownToken(),
  ];
});

/** A safe description of any error: no error object, and no secrets. */
export function describeError(error: unknown): string {
  return redact(describeDomainError(error));
}

/** The database's own log, redacted on the way out. */
export const databaseLog = new LogFile({
  name: "database",
  path: () => server.logPath(),
  displayPath: (path) => platform.displayPath(path),
  redact,
});

/** The app's own log — what platform/runtime/log.ts writes — read the same way. */
export const appLog = new LogFile({
  name: "app",
  path: () => desktopLogPath(platform),
  displayPath: (path) => platform.displayPath(path),
  redact,
});

/** Are both Plaid keys in place — from the environment or the config file? */
export function keysPresent(): boolean {
  const sources = new Map(describeConfig().map((value) => [value.key, value.source]));
  return sources.get("plaidClientId") !== "missing" && sources.get("plaidSecret") !== "missing";
}
