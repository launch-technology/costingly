/**
 * The health of everything costingly owns, in one report.
 *
 * Three artifacts, each self-reporting, each independent:
 *
 *   profile    the directory — is it there, what chose it, what is in it
 *   database   the local cluster — running, reachable, since when, on what port
 *   plaid      the API and the banks linked through it
 *
 * THE ONE RULE, INHERITED FROM checkDatabase(): NOTHING HERE THROWS, AND
 * NOTHING HERE WRITES.
 *
 * Not throwing, because a status command that fails when things are broken has
 * inverted its own purpose — the broken case is the one someone is running it
 * for. Every section records its own outcome, so an unreachable Plaid still
 * produces a full report of the two that are local.
 *
 * Not writing, because this is also how a person confirms an uninstall. A
 * report that provisioned a cluster, allocated a port or generated credentials
 * on the way to describing them would answer "is it gone?" by putting it back.
 * That is why the datastore is read through `database.admin()` and never
 * through `db`: connecting is now incapable of creating anything, but `db`
 * still starts a stopped server, and a report must not.
 *
 * WHY PLAID CANNOT BE ASKED WHAT IS LINKED
 *
 * There is no Plaid endpoint that lists the Items belonging to a client_id, and
 * no way to recover an access_token from an item_id. So the bank list can only
 * ever come from the local database, and this reports reachability separately
 * from what is linked: the first is a live fact about Plaid, the second is a
 * local record of it.
 */

import { stat } from "node:fs/promises";
import { CountryCode } from "plaid";

import { database } from "../data/default-database.js";
import { describeError, getPlaidClient } from "../data/plaid.client.js";
import { describeConfig, get, getSecretIfSet, type ResolvedValue } from "../config.js";
import { platform, server } from "../project.js";
import {
  listWithAccounts,
  type ItemAccountListing,
} from "../data/repositories/items.repository.js";
import { packageVersion } from "../../platform/package.js";
import { checkDatabase, type DatabaseHealth } from "./database/database-health.service.js";

/** How long to wait on Plaid before calling it unreachable. */
const PLAID_TIMEOUT_MS = 8_000;

export interface PlaidStatus {
  /** Whether a client_id and secret are present at all. */
  configured: boolean;
  /** "sandbox" or "production" — which set of Items these credentials see. */
  environment: string;
  /**
   * True only when Plaid answered.
   *
   * Distinct from `configured`: credentials that exist but are wrong produce
   * configured + unreachable, with the reason in `error`, which is a different
   * problem from having none at all.
   */
  reachable: boolean;
  error?: string;
}

/**
 * The profile as an artifact in its own right.
 *
 * `DatabaseHealth` already names the profile, because a database report has to
 * say which one it is talking about. This is the fuller view — when it was
 * created, what it contains, whether anything is missing — and it lives here
 * rather than being added there so the MCP health tool keeps its narrow shape.
 */
export interface ProfileStatus {
  path: string;
  /** The home variable's name when it chose the profile, else the default. */
  chosenBy: string;
  exists: boolean;
  /** When the directory was created, or null if it is not there. */
  createdAt: string | null;
  /** The config file: present, and readable only by its owner? */
  config: { exists: boolean; mode: number | null };
  clusterExists: boolean;
  /** Every setting and where it resolved from. Secrets as present/absent. */
  values: ResolvedValue[];
}

export interface CostinglyStatus {
  version: string;
  profile: ProfileStatus;
  /** Cluster, connection and schema. */
  database: DatabaseHealth;
  plaid: PlaidStatus;
  /**
   * The banks in the local database, or null when it could not be read.
   *
   * Null and empty are different answers: null is "the database did not
   * respond", empty is "it responded, and nothing is linked".
   */
  banks: ItemAccountListing[] | null;
  banksError?: string;
}

/**
 * Is Plaid reachable, and are these credentials good?
 *
 * `/institutions/get` with a count of one is the cheapest call that proves all
 * three things worth proving: the network works, the client_id and secret are
 * valid, and the environment they belong to is the one configured. Deliberately
 * NOT `/item/get`: that would require decrypting an access token, and answering
 * "is Plaid up?" must not involve touching a bank credential.
 */
async function checkPlaid(): Promise<PlaidStatus> {
  const environment = get("plaidEnv");
  const configured =
    getSecretIfSet("plaidSecret") !== undefined && (readClientId() ?? "") !== "";

  if (!configured) {
    return {
      configured: false,
      environment,
      reachable: false,
      error: "no Plaid credentials — run `costingly init`",
    };
  }

  try {
    await withTimeout(
      getPlaidClient().institutionsGet({
        count: 1,
        offset: 0,
        country_codes: [CountryCode.Us],
      }),
      PLAID_TIMEOUT_MS,
    );
    return { configured: true, environment, reachable: true };
  } catch (error) {
    return { configured: true, environment, reachable: false, error: describeError(error) };
  }
}

/** `get` throws when a key is missing; here that is an answer, not a failure. */
function readClientId(): string | undefined {
  try {
    return get("plaidClientId");
  } catch {
    return undefined;
  }
}

/**
 * The banks recorded locally, or null if the database could not be read.
 *
 * Attempted only when the health check already connected — otherwise this would
 * be a second, slower way to discover the same outage, and it reads through the
 * inspector so that asking never provisions.
 */
async function readBanks(
  connected: boolean,
): Promise<{ banks: ItemAccountListing[] | null; error?: string }> {
  if (!connected) return { banks: null };

  try {
    return { banks: await listWithAccounts(database.admin()) };
  } catch (error) {
    return { banks: null, error: describeError(error) };
  }
}

/**
 * The profile directory, described without being touched.
 *
 * `stat` only — no mkdir, no config read that could rewrite anything. A profile
 * that is absent reports absent, which is the answer someone confirming an
 * uninstall is looking for.
 */
async function checkProfile(): Promise<ProfileStatus> {
  const path = platform.profileDir();
  const [dir, config, cluster] = await Promise.all([
    describePath(path),
    describePath(platform.configPath()),
    describePath(server.dataDir()),
  ]);

  return {
    path: platform.displayPath(path),
    chosenBy: platform.profileSource() === "home variable" ? platform.homeVar : "platform default",
    exists: dir.exists,
    createdAt: dir.createdAt ?? null,
    config: { exists: config.exists, mode: config.mode ?? null },
    clusterExists: cluster.exists,
    // Reports presence and origin, never a value. A status command that printed
    // a live secret would be pasted into an issue tracker within a week.
    values: describeConfig(),
  };
}

async function describePath(
  path: string,
): Promise<{ exists: boolean; mode?: number; createdAt?: string }> {
  try {
    const info = await stat(path);
    return {
      exists: true,
      mode: info.mode & 0o777,
      createdAt: info.birthtime.toISOString().slice(0, 10),
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Everything, gathered concurrently.
 *
 * Plaid is a network round trip and the database is local, so running them in
 * parallel makes the report as slow as the slower one rather than their sum.
 * Neither can reject — both wrap their own failures — so there is no partial
 * result to reason about.
 */
export async function costinglyStatus(): Promise<CostinglyStatus> {
  const [profile, health, plaid] = await Promise.all([
    checkProfile(),
    checkDatabase(),
    checkPlaid(),
  ]);
  const { banks, error } = await readBanks(health.connection.ok);

  return {
    version: packageVersion(),
    profile,
    database: health,
    plaid,
    banks,
    ...(error === undefined ? {} : { banksError: error }),
  };
}

/**
 * Reject after `ms` rather than inheriting the SDK's own patience.
 *
 * A status command has to come back. Plaid's client will wait a long time on a
 * connection that is silently dropped, and a report nobody waits for is a
 * report nobody reads.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
