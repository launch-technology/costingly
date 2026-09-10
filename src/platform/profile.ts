/**
 * Removing a profile — everything a project keeps on this machine.
 *
 * The counterpart to `resolvePlatform`, which decides where a profile lives.
 * This deletes it: the config file, the cluster, the log, as one directory,
 * because that is exactly the promise the profile makes. Nothing of a project's
 * exists outside it, so one `rm` is the whole teardown.
 *
 * THREE STEPS, EACH GATED ON THE ONE BEFORE
 *
 *   1. Prove the target is a profile.  Deleting the wrong directory is not
 *      recoverable, and the path came from an environment variable.
 *   2. Stop the server, AND PROVE IT STOPPED.  Not the same thing: `pg_ctl`
 *      decides by reading postmaster.pid, so it reports success by omission
 *      when that file is missing.
 *   3. Delete — only once step 2 is proven.
 *
 * A step that cannot be completed aborts the whole thing. Nothing is deleted on
 * a maybe.
 *
 * WHY STEP 2 NEEDS PROOF AND NOT A RETURN VALUE
 *
 * Deleting a data directory under a live postmaster does not fail. PostgreSQL
 * on Windows opens its files with FILE_SHARE_DELETE, so the unlink succeeds,
 * no error is raised, and the server keeps serving from handles pointing at
 * files that no longer have names. What is left is a half-deleted cluster and a
 * process nothing can stop, because the pid file `pg_ctl` needs went with it.
 *
 * That state is silent, unrecoverable, and self-perpetuating. It is the reason
 * this module refuses rather than reports.
 *
 * Whether anything must happen BEFORE this — revoking a credential with a
 * third party, say — is not this layer's business. A caller that has such an
 * obligation does it first and then calls this.
 */

import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { PlatformConfig } from "./platform-config.js";
import type { Datastore } from "./datastore/datastore.js";

/** A cluster directory, named for the major version it belongs to. */
const CLUSTER_DIR = /^pg\d+$/;

export interface ProfileRemoval {
  /** The directory that was targeted, absolute. */
  profileDir: string;
  /** False when there was nothing there — not an error. */
  existed: boolean;
  /** Whether a server had to be stopped on the way. */
  serverWasRunning: boolean;
}

/**
 * Refuse to delete anything that is not recognisably a profile.
 *
 * The path comes from `${NAME}_HOME`, so a typo or an unset-but-not-empty
 * variable can point this at a home directory or a drive root. A profile always
 * holds a config file or a cluster; a directory with neither is somebody else's,
 * and the only safe response is to stop.
 *
 * Throws rather than returning false. There is no sensible way to continue, and
 * a caller that ignored a boolean would do the damage this exists to prevent.
 */
async function assertIsProfile(dir: string): Promise<void> {
  if (dir === dirname(dir)) {
    throw new Error(`Refusing to delete ${dir}: that is a filesystem root.`);
  }
  if (dir === homedir()) {
    throw new Error(`Refusing to delete ${dir}: that is your home directory.`);
  }

  const entries = await readdir(dir);
  const looksRight =
    entries.includes("config.json") || entries.some((entry) => CLUSTER_DIR.test(entry));

  if (!looksRight) {
    throw new Error(
      `Refusing to delete ${dir}: it does not look like a profile.\n\n` +
        `A profile contains config.json or a cluster directory. This one contains:\n` +
        `  ${entries.length === 0 ? "(nothing)" : entries.slice(0, 10).join(", ")}\n\n` +
        `Check the home variable before trying again.`,
    );
  }
}

/**
 * The enclosing directory that belongs to this project, or null.
 *
 * On Windows the platform-native location nests: the profile is
 * `<LOCALAPPDATA>\<name>\Data`, so deleting the profile leaves an empty
 * `<name>` folder behind and an "uninstall" that did not quite uninstall.
 *
 * Everywhere else it does NOT nest — the profile IS the project-named
 * directory, and its parent is a shared system folder:
 *
 *   Windows   <LOCALAPPDATA>\myapp\Data       parent `myapp`   -> ours
 *   macOS     ~/Library/Application Support/myapp
 *                                             parent `Application Support`
 *   Linux     ~/.local/share/myapp            parent `.local/share`
 *
 * Two conditions, and both are load-bearing. The parent must be NAMED for the
 * project, which is what tells `myapp` apart from `Application Support`. And
 * the profile must be the platform's own choice: when the home variable placed
 * it, the enclosing directory is the user's — `C:\work\profiles\test` sits in
 * `C:\work\profiles`, which we did not create and must not touch.
 *
 * Exported so the decision can be tested against a fabricated project without
 * a filesystem anywhere near the real one.
 */
export function projectParentOf(config: PlatformConfig, profileDir: string): string | null {
  if (config.profileSource() !== "platform default") return null;

  const parent = dirname(profileDir);
  if (parent === profileDir) return null;

  return basename(parent) === config.identity.name ? parent : null;
}

/**
 * Stop the server and delete the profile directory.
 *
 * A missing profile is reported, not thrown: "already gone" is the state the
 * caller asked for, and failing would make this unsafe to re-run after a
 * part-way failure.
 *
 * `rm` is given retries because Windows refuses to unlink a file another
 * process still holds, and a postmaster releases its handles fractionally after
 * `pg_ctl` returns. Node retries EBUSY/EPERM/ENOTEMPTY internally, so there is
 * no loop to write here — twenty attempts at 100ms is two seconds of patience,
 * far more than the window is ever observed to be.
 */
export async function removeProfile(
  config: PlatformConfig,
  datastore: Datastore,
): Promise<ProfileRemoval> {
  const profileDir = resolve(config.profileDir());

  try {
    await stat(profileDir);
  } catch {
    return { profileDir, existed: false, serverWasRunning: false };
  }

  // --- step 1: is this ours? ----------------------------------------------
  await assertIsProfile(profileDir);

  // --- step 2: stop it, and prove it ---------------------------------------
  const serverWasRunning = await datastore.stop();
  if (await datastore.isServing()) {
    throw new Error(
      `Refusing to delete ${profileDir}: the database is still running.\n\n` +
        `It was asked to stop, but something is still answering on this profile's\n` +
        `port. Deleting now would remove the files out from under a live server —\n` +
        `which does not fail, it corrupts: the cluster is destroyed while the\n` +
        `process keeps going, and nothing is left that can stop it.\n\n` +
        `Close whatever is using the database and try again. If a desktop app is\n` +
        `connected to this profile, quit it first.`,
    );
  }

  // --- step 3: delete ------------------------------------------------------
  await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

  // And the project-named directory around it, where the platform nests one.
  // `rmdir`, never a recursive delete: it fails on a non-empty directory, and
  // that failure IS the safety check. Anything the user put there survives.
  const parent = projectParentOf(config, profileDir);
  if (parent !== null) {
    await rmdir(parent).catch(() => {
      // Not empty, or already gone. Neither is worth failing an uninstall over
      // — the profile itself, which is what was asked for, is deleted.
    });
  }

  return { profileDir, existed: true, serverWasRunning };
}
