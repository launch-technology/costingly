/**
 * Configuration, backed by `config.json` inside the profile.
 *
 * The file is owned by the application, not the user: `costingly init` writes
 * it. It is readable, and editable in a pinch, but nobody is expected to
 * hand-edit it — which is what lets it be JSON and lets the app rewrite it
 * safely.
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
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath, displayPath } from "./profile.js";

/** Owner read/write only. This file holds live credentials. */
const FILE_MODE = 0o600;

export type PlaidEnvName = "sandbox" | "production";

/** Everything `costingly init` writes. */
export interface StoredConfig {
  plaidClientId: string;
  plaidSecret: string;
  encryptionKey: string;
  plaidEnv: PlaidEnvName;

}

/**
 * The file on disk. A superset of `StoredConfig`: the scalar keys above, plus
 * sections that are stored but never resolved from the environment.
 */
export interface ConfigFile extends Partial<StoredConfig> {
  ports?: Record<string, number>;
}

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
  /** The local Plaid Link web server, not the database — that uses a socket. */

};

export type ValueSource = "environment" | "config file" | "default" | "missing";

export interface ResolvedValue {
  key: keyof StoredConfig;
  source: ValueSource;
  /** Secrets are reported as present/absent, never rendered. */
  display: string;
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/**
 * Read `config.json`, or an empty object when it does not exist.
 *
 * Read synchronously and NOT cached: the profile can move between calls (tests
 * do exactly that), and the file is small enough that re-reading costs nothing
 * next to the work every command does anyway.
 *
 * A file that exists but cannot be parsed is a hard error. Silently treating
 * corrupt JSON as "no config" would send the user to `costingly init` and have
 * them overwrite a file that might hold the only copy of their encryption key.
 */
function readStored(): ConfigFile {
  const path = configPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Partial<StoredConfig>;
  } catch (error) {
    throw new Error(
      `Could not read ${displayPath(path)}:\n  ${error instanceof Error ? error.message : String(error)}\n\n` +
        `Fix the file, or move it aside and run \`costingly init\` to create a new one.\n` +
        `If it holds the only copy of your encryption key, do NOT delete it — a lost key\n` +
        `means re-linking every bank.`,
    );
  }
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
 * Write the config file atomically, owner-only.
 *
 * chmod happens on the temp file *before* the rename, so the config is never
 * momentarily world-readable at its final path.
 */
export async function writeConfig(values: StoredConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temp = join(dirname(path), `.config.${process.pid}.tmp`);
  // Merged, not replaced. The file also holds sections this function knows
  // nothing about — the ports the allocator recorded — and `init` re-runs
  // through here. A wholesale write would discard them silently.
  const body = `${JSON.stringify({ ...readStored(), ...values }, null, 2)}\n`;
  try {
    await writeFile(temp, body, { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Read the file as-is. For `init`, which needs to know what already exists. */
export function readConfigFile(): ConfigFile {
  return readStored();
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
 * Merge values into `config.json`, preserving everything already in it.
 *
 * Synchronous because its one caller sits under `encrypt()`/`decrypt()`, which
 * are synchronous, and making those async would ripple through every call site
 * to save nothing — this writes a few hundred bytes, once, on first use.
 *
 * Only what is already in the FILE is preserved. Values resolved from the
 * environment are deliberately not written back: an environment variable is a
 * per-invocation override, and persisting one would silently turn a temporary
 * setting into permanent state.
 */
export function updateConfigSync(patch: Partial<ConfigFile>): void {
  const path = configPath();
  // readStored() throws on unparseable JSON rather than treating it as empty.
  // That matters more here than anywhere else: silently starting from {} would
  // drop an existing encryption key and orphan every stored access token.
  const merged = { ...readStored(), ...patch };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.config.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, { mode: FILE_MODE });
    chmodSync(temp, FILE_MODE);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}


// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Ports live in their own section, deliberately outside `StoredConfig`.
 *
 * Every scalar key above exists because the value must come from OUTSIDE — the
 * Plaid credentials and the encryption key arrive through Claude Desktop's
 * settings, and PLAID_ENV is how the sandbox profile flips environments. Each
 * therefore needs an environment override and a place in `resolve()`.
 *
 * A port is the opposite: the allocator's whole job is to invent one. There is
 * nothing to override and no default to keep here — the defaults belong to the
 * service that hands ports out. So this is a plain stored blob, read and written
 * by that service and by nothing else.
 */
export function readPorts(): Record<string, number> {
  const raw = readStored().ports;
  if (raw === undefined || typeof raw !== "object") return {};

  const clean: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    // A hand-edited or corrupted entry should not take the whole file down: the
    // allocator can always find another port, and refusing to start because a
    // remembered number is malformed helps nobody.
    if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) {
      clean[name] = value;
    }
  }
  return clean;
}

/** Merges, so it can never drop a port belonging to another service. */
export function writePorts(ports: Record<string, number>): void {
  updateConfigSync({ ports });
}
