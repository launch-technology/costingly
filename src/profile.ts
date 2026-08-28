/**
 * Where costingly keeps everything it owns.
 *
 * One directory per environment — the "profile" — holding the config file, the
 * Postgres cluster, its socket and its log. Back it up, move it or delete it as
 * a unit; nothing of costingly's lives anywhere else on the machine.
 *
 * Two deliberate choices:
 *
 *   The location is platform-native, via `env-paths`. A macOS user expects
 *   application data under ~/Library/Application Support, a Windows user under
 *   %LOCALAPPDATA%; a dotfolder in the home directory is a Unix habit that
 *   neither platform's backup or migration tooling understands.
 *
 *   Only `env-paths`' *data* directory is used. Its config/cache/log/temp
 *   directories would scatter the profile across four places, which is the
 *   thing this module exists to avoid — and `temp` in particular resolves under
 *   /var/folders on macOS, which the OS reaps periodically. A reaped socket
 *   directory under a running postmaster is a very confusing failure.
 *
 * Nothing here creates directories. Callers do that at the point of first
 * write, so simply importing this module never touches the disk.
 */

import envPaths from "env-paths";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Used for the profile directory name. One place to change on a rename. */
export const APP_NAME = "costingly";

export type ProfileSource = "COSTINGLY_HOME" | "platform default";

/**
 * The profile directory.
 *
 * `COSTINGLY_HOME` overrides it wholesale — the single lever for development,
 * the sandbox profile, integration tests wanting a fresh tmpdir, CI, and anyone
 * who would rather keep their data on an external volume. One mechanism, five
 * callers.
 *
 * A relative value is resolved against the current directory, so
 * `COSTINGLY_HOME=./.dev` means what it looks like. It is resolved on every
 * call rather than cached, so tests can move the profile between assertions.
 */
export function profileDir(): string {
  const override = process.env["COSTINGLY_HOME"];
  if (override !== undefined && override.trim() !== "") {
    return resolve(override.trim());
  }

  // `suffix: ""` matters — env-paths appends "-nodejs" by default, which would
  // put user-visible data in a directory named after our implementation.
  return envPaths(APP_NAME, { suffix: "" }).data;
}

/**
 * Why the profile resolved where it did.
 *
 * For `costingly doctor`. With COSTINGLY_HOME settable from a shell, a .env or
 * a CI runner, "which profile is this, and what chose it?" is the first
 * question in every misconfiguration.
 */
export function profileSource(): ProfileSource {
  const override = process.env["COSTINGLY_HOME"];
  return override !== undefined && override.trim() !== ""
    ? "COSTINGLY_HOME"
    : "platform default";
}

/** The config file. Written by `costingly init`, never hand-edited. */
export function configPath(): string {
  return join(profileDir(), "config.json");
}

/**
 * The profile path with the home directory shortened to `~`.
 *
 * Purely for display. The platform-native location is long and contains a space
 * on macOS, so raw paths make CLI output hard to scan.
 */
export function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
