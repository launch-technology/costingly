/**
 * `config.json` as a file, with no opinion about what is in it.
 *
 * Reading, merging and writing the profile's config file, plus the two sections
 * that belong to the machinery rather than to any application: the database
 * logins costingly generated for itself, and the ports the allocator recorded.
 *
 * Deliberately knows nothing about Plaid keys or encryption keys. Those are one
 * application's settings and live with that application — see config.ts, which
 * layers them on top of this. The split is what lets the file mechanics be
 * reused by a second application without carrying costingly's key set.
 *
 * Every write is atomic and owner-only, and every write MERGES: the file holds
 * sections written by code that knows nothing about the section next to it, and
 * a wholesale write would discard them silently.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath, displayPath } from "./profile.js";

/** Owner read/write only. This file holds live credentials. */
export const FILE_MODE = 0o600;

export interface DatabaseLogin {
  user: string;
  password: string;
}

/** The database roles costingly created, and how to authenticate as them. */
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
 * corrupt JSON as "no config" would send the user to `costingly init` and have
 * them overwrite a file that might hold the only copy of their encryption key.
 */
export function readStoredFile(): ConfigFileShape {
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
    return parsed as ConfigFileShape;
  } catch (error) {
    throw new Error(
      `Could not read ${displayPath(path)}:\n  ${error instanceof Error ? error.message : String(error)}\n\n` +
        `Fix the file, or move it aside and run \`costingly init\` to create a new one.\n` +
        `If it holds the only copy of your encryption key, do NOT delete it — a lost key\n` +
        `means re-linking every bank.`,
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
 * holds a handle to it — and several costingly processes starting at once do
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
export function updateConfigSync(patch: Record<string, unknown>): void {
  const path = configPath();
  // readStoredFile() throws on unparseable JSON rather than treating it as
  // empty. That matters more here than anywhere else: silently starting from {}
  // would drop an existing encryption key and orphan every stored access token.
  const merged = { ...readStoredFile(), ...patch };

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
export async function updateConfigFile(patch: Record<string, unknown>): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temp = join(dirname(path), `.config.${process.pid}.tmp`);
  const body = `${JSON.stringify({ ...readStoredFile(), ...patch }, null, 2)}\n`;
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
export function readPorts(): Record<string, number> {
  const raw = readStoredFile().ports;
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
export function readDatabaseLogins(): DatabaseLogins | undefined {
  const raw = readStoredFile().database;
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

/** Merges, so it cannot disturb any application settings stored beside it. */
export function writeDatabaseLogins(database: DatabaseLogins): void {
  updateConfigSync({ database });
}
