/**
 * First-run setup, as the desktop app does it.
 *
 * The same steps as `costingly init`, in the same order: prove the keys with
 * Plaid, save them, create the database. The sequencing is repeated here
 * rather than shared because it lives inside the CLI's command today and one
 * interface may not import another; the CLI's copy goes when the CLI does.
 *
 * EVERYTHING THIS NEEDS IS HANDED TO IT. The service names what it depends on
 * — a datastore to ask, a config to read and write, something that can verify
 * keys, something that can install — and the application supplies the real
 * ones (adapters/domain.ts). That is what lets a test hand it a Plaid that
 * times out or an install that fails, which no real profile can be made to do
 * on demand.
 *
 * No Electron and no domain imports beyond types: this file is the order of
 * operations and the decisions between them, and nothing else.
 */

import type { ConfigFile, PlaidEnvName, ResolvedValue, StoredConfig } from "../../../../domain/config.js";
import type { DatastoreState } from "../../../../platform/datastore/datastore.js";
import type { DatabaseResult, KeysResult, SetupState } from "../../bridge/contract.js";

/** What became of a pair of keys offered to Plaid. */
export type KeyVerdict =
  | { accepted: true }
  | { accepted: false; kind: "rejected" | "unreachable"; reason: string };

/**
 * Something that can prove a pair of keys with Plaid.
 *
 * On acceptance the keys are in effect for the rest of the process; on
 * refusal nothing is. How that is arranged is the implementation's business.
 */
export interface KeyVerifier {
  verify(clientId: string, secret: string): Promise<KeyVerdict>;
}

export interface SetupDependencies {
  /** The profile's datastore: is there one, and where does it keep its data. */
  datastore: { status(): Promise<DatastoreState>; dataDir(): string };
  config: {
    /** Every setting and where it resolved from, secrets as present/absent. */
    describe(): ResolvedValue[];
    /** The config file as it is on disk. */
    readFile(): ConfigFile;
    write(values: StoredConfig): Promise<void>;
    /** The Plaid environment currently in effect. */
    plaidEnv(): PlaidEnvName;
  };
  keys: KeyVerifier;
  /** Create the database, or bring an existing one up to date. Idempotent. */
  install(): Promise<void>;
  newEncryptionKey(): string;
  /** The profile directory, shortened for display. */
  dataFolder(): string;
  /** Whether a path exists. For the one case the datastore cannot be asked. */
  pathExists(path: string): boolean;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
}

export class SetupService {
  constructor(private readonly deps: SetupDependencies) {}

  /**
   * What is already in place on this machine. Reads only; no network.
   *
   * Deliberately NOT the status report's list of blockers. That list includes
   * "Plaid did not respond" and "the server is not running", and neither means
   * setup is unfinished — a laptop on a train is still set up.
   */
  async state(): Promise<SetupState> {
    return {
      keysPresent: this.keysPresent(),
      databaseCreated: await this.databaseCreated(),
      dataFolder: this.deps.dataFolder(),
    };
  }

  /**
   * Prove a pair of keys with Plaid, and save them only if Plaid accepts them.
   */
  async submitKeys(clientId: string, secret: string): Promise<KeysResult> {
    const id = clientId.trim();
    const key = secret.trim();
    if (id === "" || key === "") {
      return { outcome: "rejected", reason: "Both the client ID and the secret are required." };
    }

    const verdict = await this.deps.keys.verify(id, key);
    if (!verdict.accepted) return { outcome: verdict.kind, reason: verdict.reason };

    try {
      await this.deps.config.write({
        plaidClientId: id,
        plaidSecret: key,
        // Never regenerated. Replacing it would make every stored bank token
        // permanently undecryptable; a machine that already has a database has
        // tokens this key protects.
        encryptionKey: this.deps.config.readFile().encryptionKey ?? this.deps.newEncryptionKey(),
        // Whichever environment the check just ran against. Production for
        // every user; sandbox only when a contributor launched the app that
        // way, and then the profile stays a sandbox profile on the next launch.
        plaidEnv: this.deps.config.plaidEnv(),
      });
    } catch (error) {
      // Plaid said yes and the disk said no. Not "rejected" — retyping the keys
      // will not help — so it is reported as the other kind of failure, in words.
      return {
        outcome: "unreachable",
        reason: `Plaid accepted the keys, but they could not be saved: ${this.deps.describeError(error)}`,
      };
    }

    return { outcome: "accepted" };
  }

  async createDatabase(): Promise<DatabaseResult> {
    try {
      await this.deps.install();
      return { outcome: "ready" };
    } catch (error) {
      return { outcome: "failed", reason: this.deps.describeError(error) };
    }
  }

  private keysPresent(): boolean {
    const sources = new Map(this.deps.config.describe().map((value) => [value.key, value.source]));
    return sources.get("plaidClientId") !== "missing" && sources.get("plaidSecret") !== "missing";
  }

  private async databaseCreated(): Promise<boolean> {
    try {
      return (await this.deps.datastore.status()) !== "uninitialised";
    } catch {
      // The datastore itself could not be asked. Its directory is the next
      // best evidence, and guessing "not created" here would offer to create a
      // database on top of one that exists.
      return this.deps.pathExists(this.deps.datastore.dataDir());
    }
  }
}
