/**
 * Costingly's own settings, read from `config.json`.
 *
 * The file underneath is owned by the application, not the user: setup writes
 * it. It is readable, and editable in a pinch, but nobody is expected to
 * hand-edit it — which is what lets it be JSON and lets the app rewrite it
 * safely.
 *
 * The file is the only source. There used to be an environment layer above
 * it, which existed for the old Claude Desktop extension's install form and
 * for one-off overrides; both are gone, and a value in the environment is
 * ignored. No setting has a default: each is either saved or missing.
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

import { platform } from "./project.js";
import { configStore } from "./project.js";
import type { StoredSections } from "../platform/config-store.js";

/**
 * Everything `costingly init` writes.
 *
 * There is no setting for which Plaid to talk to, deliberately. The product
 * talks to production; the sandbox is something the test suites construct for
 * themselves (see data/plaid.client.ts). A config file written by an older
 * version may still carry a `plaidEnv` key — it is ignored.
 */
export interface StoredConfig {
  plaidClientId: string;
  plaidSecret: string;
  encryptionKey: string;
}

/**
 * The file on disk as this application sees it: its own scalar keys, plus the
 * sections the store owns and this module never touches.
 */
export interface ConfigFile extends Partial<StoredConfig>, StoredSections {}

export type SecretName = "plaidSecret" | "encryptionKey";
export type PublicName = "plaidClientId";

const KEYS: readonly (keyof StoredConfig)[] = ["plaidClientId", "plaidSecret", "encryptionKey"];

export type ValueSource = "config file" | "missing";

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
  return configStore.read() as ConfigFile;
}

/** The raw resolved value for a key, before validation. */
function resolve(key: keyof StoredConfig): { value: string | number | undefined; source: ValueSource } {
  const stored = readStored()[key];
  if (stored !== undefined && stored !== "") {
    return { value: stored, source: "config file" };
  }

  return { value: undefined, source: "missing" };
}

function missing(key: keyof StoredConfig): Error {
  return new Error(
    `${key} is not set.\n\n` +
      `Looked in:\n  ${platform.displayPath(platform.configPath())}\n\n` +
      `Finish Costingly's setup to save it.`,
  );
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/** A non-secret value. Throws with an actionable message when unset. */
export function get<K extends PublicName>(key: K): StoredConfig[K] {
  const { value } = resolve(key);
  if (value === undefined) throw missing(key);
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
  return KEYS.map((key) => {
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
  await configStore.updateAsync({ ...values });
}

/** Read the file as-is. For `init`, which needs to know what already exists. */
export function readConfigFile(): ConfigFile {
  return readStored();
}
