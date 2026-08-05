/**
 * Exclusive lock for the embedded database directory.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE EXISTS ONLY BECAUSE UPSTREAM HAS NOT SHIPPED ITS OWN LOCK.
 *
 * PGlite performs no locking: its NodeFS backend does `mkdir` + `mount` and
 * nothing else, and Postgres's own postmaster.pid machinery never runs because
 * PGlite links the backend directly rather than starting a postmaster. Two
 * processes therefore open the same data directory silently, both run crash
 * recovery, and corrupt each other.
 *
 * electric-sql/pglite PR #892 adds exactly this. When it merges and ships:
 *   1. delete this file
 *   2. revert the three edits in createPgliteDriver() in db.ts
 * The mechanism here is deliberately identical to that PR — same sibling
 * `<dataDir>.lock` path, same pid contents, same liveness-based staleness — so
 * the swap changes no behaviour.
 * ---------------------------------------------------------------------------
 *
 * Applies to the embedded database only. A real Postgres server reached through
 * DATABASE_URL has its own concurrency control and is never locked here.
 */

import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";

/** Thrown when another live process holds the lock. */
export class DatabaseBusyError extends Error {
  readonly pid: number;

  constructor(pid: number, lockPath: string) {
    super(
      `Another plaid-sync command is using the database (pid ${pid}).\n\n` +
        `Wait for it to finish, or stop it. If you are certain nothing is running:\n` +
        `  rm ${lockPath}`,
    );
    this.name = "DatabaseBusyError";
    this.pid = pid;
  }
}

function lockPathFor(dataDir: string): string {
  // A sibling, never inside the directory: PGDATA is mounted into PGlite's
  // WASM filesystem and belongs to Postgres.
  return `${dataDir}.lock`;
}

/** Is a process with this pid still running? */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything. EPERM means it exists but belongs to another user — still alive.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the pid out of an existing lock. Returns null when the file is missing
 * or its contents are unusable — a truncated write from a crash reads as stale
 * rather than wedging the tool forever.
 */
async function readHolder(lockPath: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock, returning a release function.
 *
 * Throws `DatabaseBusyError` if a live process holds it. A lock left behind by
 * a crashed run (dead pid, or unreadable) is reclaimed automatically.
 */
export async function acquireDataDirLock(dataDir: string): Promise<() => Promise<void>> {
  const lockPath = lockPathFor(dataDir);

  // Two attempts at most: the second exists only to cover the narrow race where
  // another process reclaims the same stale lock between our read and rename.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // "wx" is O_CREAT|O_EXCL — atomic, so two racing processes cannot both win.
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return () => releaseLock(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const holder = await readHolder(lockPath);
      if (holder !== null && isAlive(holder)) {
        throw new DatabaseBusyError(holder, lockPath);
      }

      // Stale. Claim it by renaming our own file over it, which is atomic — if
      // someone else reclaims first, one of us simply overwrites the other and
      // the loop's second pass re-checks liveness.
      const claim = `${lockPath}.${process.pid}.tmp`;
      await writeFile(claim, String(process.pid));
      try {
        await rename(claim, lockPath);
      } catch (renameError) {
        await unlink(claim).catch(() => {});
        throw renameError;
      }

      const owner = await readHolder(lockPath);
      if (owner === process.pid) return () => releaseLock(lockPath);
      // Lost the race; loop once more and report whoever won.
    }
  }

  const holder = await readHolder(lockPath);
  throw new DatabaseBusyError(holder ?? 0, lockPath);
}

/**
 * Release, but only if we still own it.
 *
 * Idempotent, and deliberately quiet: this runs on the teardown path where
 * throwing would mask whatever real error is already on its way out.
 */
async function releaseLock(lockPath: string): Promise<void> {
  try {
    if ((await readHolder(lockPath)) !== process.pid) return;
    await unlink(lockPath);
  } catch {
    // Already gone, or not ours to remove.
  }
}
