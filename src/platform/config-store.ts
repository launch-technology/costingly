/**
 * `config.json` as a file, with no opinion about what is in it.
 *
 * Reading, merging and writing the profile's config file, plus the two sections
 * that belong to the machinery rather than to any application: the database
 * logins the project generated for itself, and the ports the allocator recorded.
 *
 * Deliberately knows nothing about Plaid keys or encryption keys. Those are one
 * application's settings and live with that application — see config.ts, which
 * layers them on top of this. The split is what lets the file mechanics be
 * reused by a second application without carrying another's key set.
 *
 * Every write is atomic and owner-only, and every write MERGES: the file holds
 * sections written by code that knows nothing about the section next to it, and
 * a wholesale write would discard them silently.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlatformConfig } from "./platform-config.js";

/** Owner read/write only. This file holds live credentials. */
export const FILE_MODE = 0o600;

export interface DatabaseLogin {
  user: string;
  password: string;
}

/** The database roles the project created, and how to authenticate as them. */
export interface DatabaseLogins {
  superuser: DatabaseLogin;
  app: DatabaseLogin;
}

/**
 * The sections this module owns.
 *
 * Both exist because the value is GENERATED here and supplied by nobody, which
 * is why neither has an environment override the way an application's settings
 * do.
 */
export interface StoredSections {
  database?: DatabaseLogins;
  ports?: Record<string, number>;
}

/** The file: the sections above, plus whatever an application put beside them. */
export type ConfigFileShape = StoredSections & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read `config.json`, or an empty object when it does not exist.
 *
 * Read synchronously and NOT cached: the profile can move between calls (tests
 * do exactly that), and the file is small enough that re-reading costs nothing
 * next to the work every command does anyway.
 *
 * A file that exists but cannot be parsed is a hard error. Silently treating
 * corrupt JSON as "no config" would send the user to setup and have them
 * overwrite a file that might hold the only copy of their encryption key.
 */
function readStoredFileAt(config: PlatformConfig): ConfigFileShape {
  const path = config.configPath();
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
    return parsed as ConfigFileShape;
  } catch (error) {
    throw new Error(
      `Could not read ${config.displayPath(path)}:\n  ${error instanceof Error ? error.message : String(error)}\n\n` +
        `Fix the file, or move it aside and run \`${config.identity.name} init\` to create a new one.\n` +
        `If it holds the only copy of your encryption key, do NOT delete it — a lost key\n` +
        `means re-linking every connected account.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** How long to keep retrying a rename the filesystem is briefly refusing. */
const RENAME_DEADLINE_MS = 2_000;
const RENAME_PAUSE_MS = 10;

/** Transient on Windows; never returned by a rename that is genuinely wrong. */
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Rename over a destination another process may have open.
 *
 * On Windows a rename onto an existing file fails with EPERM when anyone else
 * holds a handle to it — and several of a project's processes starting at once
 * exactly that: each reads config.json to find the port, and the ones that lose
 * the race to bind it write a different port back. Measured: six concurrent
 * cold starts failed this way roughly two runs in five.
 *
 * POSIX rename is atomic and never hits this, so the retry is a no-op there.
 * The pause is a real sleep rather than a spin: the window is the microseconds
 * another process needs to close its read handle, and burning a core to wait
 * for it would make the contention worse.
 */
function renameOverBusy(from: string, to: string): void {
  const deadline = Date.now() + RENAME_DEADLINE_MS;

  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!BUSY_CODES.has(code) || Date.now() > deadline) throw error;
      sleepSync(RENAME_PAUSE_MS);
    }
  }
}

/**
 * Block this thread briefly.
 *
 * `Atomics.wait` on a buffer nobody notifies is the only real sleep available to
 * synchronous code. The alternative — a busy loop on Date.now() — holds a core
 * for the whole pause, which is precisely the wrong thing to do while waiting
 * for another process to finish.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Merge values into `config.json`, preserving everything already in it.
 *
 * Synchronous because one caller sits under `encrypt()`/`decrypt()`, which are
 * synchronous, and making those async would ripple through every call site to
 * save nothing — this writes a few hundred bytes, once, on first use.
 *
 * Only what is already in the FILE is preserved. Values resolved from the
 * environment are deliberately not written back: an environment variable is a
 * per-invocation override, and persisting one would silently turn a temporary
 * setting into permanent state.
 */
function updateConfigSyncAt(config: PlatformConfig, patch: Record<string, unknown>): void {
  const path = config.configPath();
  // readStoredFileAt() throws on unparseable JSON rather than treating it as
  // empty. That matters more here than anywhere else: silently starting from {}
  // would drop an existing encryption key and orphan every stored access token.
  const merged = { ...readStoredFileAt(config), ...patch };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.config.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, { mode: FILE_MODE });
    chmodSync(temp, FILE_MODE);
    renameOverBusy(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file was never created, or is already gone. Either way the
      // error worth reporting is the one below.
    }
    throw error;
  }
}

/**
 * Merge values into `config.json`, asynchronously.
 *
 * chmod happens on the temp file *before* the rename, so the config is never
 * momentarily world-readable at its final path.
 */
async function updateConfigFileAt(
  config: PlatformConfig,
  patch: Record<string, unknown>,
): Promise<void> {
  const path = config.configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temp = join(dirname(path), `.config.${process.pid}.tmp`);
  const body = `${JSON.stringify({ ...readStoredFileAt(config), ...patch }, null, 2)}\n`;
  try {
    await writeFile(temp, body, { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    // Same Windows contention as the synchronous path — see renameOverBusy.
    for (const deadline = Date.now() + RENAME_DEADLINE_MS; ; ) {
      try {
        await rename(temp, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!BUSY_CODES.has(code) || Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, RENAME_PAUSE_MS));
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The ports the allocator has recorded, ignoring any entry that is malformed. */
function readPortsAt(config: PlatformConfig): Record<string, number> {
  const raw = readStoredFileAt(config).ports;
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


// ---------------------------------------------------------------------------
// Database logins
// ---------------------------------------------------------------------------

/**
 * The database credentials, or undefined if the cluster has not been created.
 *
 * The USERNAME is stored beside the password rather than hardcoded. It records
 * what the cluster actually has: renaming a role in a later version would
 * otherwise leave existing clusters unreachable by a name that no longer exists.
 */
function readDatabaseLoginsAt(config: PlatformConfig): DatabaseLogins | undefined {
  const raw = readStoredFileAt(config).database;
  if (raw === undefined || typeof raw !== "object") return undefined;

  const ok = (l: unknown): l is DatabaseLogin =>
    typeof l === "object" &&
    l !== null &&
    typeof (l as DatabaseLogin).user === "string" &&
    typeof (l as DatabaseLogin).password === "string" &&
    (l as DatabaseLogin).user !== "" &&
    (l as DatabaseLogin).password !== "";

  // Partial credentials are worse than none: they would produce an opaque
  // authentication failure several steps later instead of a clear "not set up".
  if (!ok(raw.superuser) || !ok(raw.app)) return undefined;
  return { superuser: raw.superuser, app: raw.app };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * Everything above, bound to one project's config file.
 *
 * A factory rather than module-level functions so a caller can hold two stores
 * over two profiles at once. Tests previously had to mutate `process.env` to
 * reach a second profile, which meant they could only ever exercise the global
 * path.
 */
export interface ConfigStore {
  read(): ConfigFileShape;
  update(patch: Record<string, unknown>): void;
  updateAsync(patch: Record<string, unknown>): Promise<void>;
  readPorts(): Record<string, number>;
  /** Merges, so it can never drop a port belonging to another service. */
  writePorts(ports: Record<string, number>): void;
  readDatabaseLogins(): DatabaseLogins | undefined;
  /** Merges, so it cannot disturb any application settings stored beside it. */
  writeDatabaseLogins(database: DatabaseLogins): void;
}

export function createConfigStore(config: PlatformConfig): ConfigStore {
  return {
    read: () => readStoredFileAt(config),
    update: (patch) => updateConfigSyncAt(config, patch),
    updateAsync: (patch) => updateConfigFileAt(config, patch),
    readPorts: () => readPortsAt(config),
    writePorts: (ports) => updateConfigSyncAt(config, { ports }),
    readDatabaseLogins: () => readDatabaseLoginsAt(config),
    writeDatabaseLogins: (database) => updateConfigSyncAt(config, { database }),
  };
}
