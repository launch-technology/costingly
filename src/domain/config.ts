/**
 * Costingly's own settings, resolved from the environment or `config.json`.
 *
 * The file underneath is owned by the application, not the user: `costingly
 * init` writes it. It is readable, and editable in a pinch, but nobody is
 * expected to hand-edit it — which is what lets it be JSON and lets the app
 * rewrite it safely.
 *
 * Resolution, highest priority first:
 *
 *   1. environment variables   PLAID_SECRET=... costingly sync
 *   2. config.json             what `costingly init` wrote
 *   3. defaults in source
 *
 * (CLI flags sit above all of these; commander applies them at the call site.)
 *
 * The environment layer is what makes CI work with no file at all, and what
 * makes a one-off override possible without editing anything.
 *
 * Secrets go through `getSecret()` rather than `get()`. They live in the same
 * file today, at mode 0600 — no better protected than a dotfile was. The point
 * of the separate accessor is that call sites stop caring where secrets come
 * from, so moving them into the OS keychain later is one module rather than a
 * sweep of the codebase.
 *
 * THE KEYS ARE THE COSTINGLY PART. Reading and writing the file is not, and
 * lives in config-store.ts. Only this module names Plaid.
 */

import { configPath, displayPath } from "../platform/profile.js";
import {
  readStoredFile,
  updateConfigFile,
  type StoredSections,
} from "../platform/config-store.js";

export type PlaidEnvName = "sandbox" | "production";

/** Everything `costingly init` writes. */
export interface StoredConfig {
  plaidClientId: string;
  plaidSecret: string;
  encryptionKey: string;
  plaidEnv: PlaidEnvName;
}

/**
 * The file on disk as this application sees it: its own scalar keys, plus the
 * sections the store owns and this module never touches.
 */
export interface ConfigFile extends Partial<StoredConfig>, StoredSections {}

export type SecretName = "plaidSecret" | "encryptionKey";
export type PublicName = "plaidClientId" | "plaidEnv";

/** The environment variable that overrides each key. */
const ENV_NAMES: Record<keyof StoredConfig, string> = {
  plaidClientId: "PLAID_CLIENT_ID",
  plaidSecret: "PLAID_SECRET",
  encryptionKey: "ENCRYPTION_KEY",
  plaidEnv: "PLAID_ENV",
};

const DEFAULTS = {
  /** Users are always on production. Only the sandbox test profile sets this. */
  plaidEnv: "production" as PlaidEnvName,
};

export type ValueSource = "environment" | "config file" | "default" | "missing";

export interface ResolvedValue {
  key: keyof StoredConfig;
  source: ValueSource;
  /** Secrets are reported as present/absent, never rendered. */
  display: string;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function readStored(): ConfigFile {
  return readStoredFile() as ConfigFile;
}

/**
 * A `${user_config.whatever}` token that was never filled in.
 *
 * Claude Desktop substitutes these into the environment from the extension's
 * settings form — and when a field is left blank it passes the **literal
 * placeholder** rather than an empty string or nothing at all. Measured from a
 * running install:
 *
 *     PLAID_CLIENT_ID=${user_config.plaid_client_id}
 *
 * Which is a non-empty string, so without this check it reads as a configured
 * value, and the first symptom is Plaid rejecting it: "client_id must be a
 * properly formatted, non-empty string". Treating it as absent is what turns
 * that into "go and enter your keys".
 *
 * Deliberately narrow: only a value that is *entirely* one `${...}` token. No
 * real credential looks like that.
 */
function isUnfilledPlaceholder(value: string): boolean {
  return /^\$\{[^}]*\}$/.test(value.trim());
}

/** The raw resolved value for a key, before validation. */
function resolve(key: keyof StoredConfig): { value: string | number | undefined; source: ValueSource } {
  const fromEnv = process.env[ENV_NAMES[key]];
  if (fromEnv !== undefined && fromEnv.trim() !== "" && !isUnfilledPlaceholder(fromEnv)) {
    return { value: fromEnv.trim(), source: "environment" };
  }

  const stored = readStored()[key];
  if (stored !== undefined && stored !== "") {
    return { value: stored, source: "config file" };
  }

  if (key in DEFAULTS) {
    return { value: DEFAULTS[key as keyof typeof DEFAULTS], source: "default" };
  }

  return { value: undefined, source: "missing" };
}

function missing(key: keyof StoredConfig): Error {
  return new Error(
    `${ENV_NAMES[key]} is not set.\n\n` +
      `Looked in the environment and in:\n  ${displayPath(configPath())}\n\n` +
      `Run \`costingly init\` to set it up.`,
  );
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/** A non-secret value. Throws with an actionable message when unset. */
export function get<K extends PublicName>(key: K): StoredConfig[K] {
  const { value } = resolve(key);
  if (value === undefined) throw missing(key);

  if (key === "plaidEnv") {
    const raw = String(value).trim().toLowerCase();
    if (raw !== "sandbox" && raw !== "production") {
      throw new Error(
        `Invalid plaidEnv: "${String(value)}". Must be "sandbox" or "production".\n` +
          `(Plaid retired the "development" environment; use sandbox for testing.)`,
      );
    }
    return raw as StoredConfig[K];
  }

  return String(value) as StoredConfig[K];
}

/**
 * A secret. Same store as `get()` today; separate on purpose.
 *
 * Keep this the only way secrets are read. When they move to the OS keychain
 * this function changes and nothing else does.
 */
export function getSecret(key: SecretName): string {
  const { value } = resolve(key);
  if (value === undefined) throw missing(key);
  return String(value);
}

/**
 * A secret if it is set anywhere, or undefined. Never throws.
 *
 * `getSecret()` is right for a value the program cannot run without — its throw
 * carries an actionable message. This is for the caller that has a plan for the
 * absent case, which today means the encryption key: it can be created rather
 * than demanded.
 */
export function getSecretIfSet(key: SecretName): string | undefined {
  const { value } = resolve(key);
  return value === undefined ? undefined : String(value);
}

/**
 * Every key, its source, and a safe rendering. For `costingly doctor`.
 *
 * Secrets report presence only. A diagnostic command that printed live
 * credentials would be pasted into an issue tracker within a week.
 */
export function describeConfig(): ResolvedValue[] {
  return (Object.keys(ENV_NAMES) as (keyof StoredConfig)[]).map((key) => {
    const { value, source } = resolve(key);
    const secret = key === "plaidSecret" || key === "encryptionKey";
    const display =
      value === undefined ? "not set" : secret ? "set (hidden)" : String(value);
    return { key, source, display };
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write costingly's settings, merged into whatever else the file holds.
 *
 * `init` re-runs through here, and the file also carries sections this function
 * knows nothing about — the ports the allocator recorded, the database logins.
 * The merge is what stops a re-run discarding them.
 */
export async function writeConfig(values: StoredConfig): Promise<void> {
  await updateConfigFile({ ...values });
}

/** Read the file as-is. For `init`, which needs to know what already exists. */
export function readConfigFile(): ConfigFile {
  return readStored();
}
