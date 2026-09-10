/**
 * Everything the platform needs to know about the project running on it.
 *
 * One place that turns a project's identity — its name, its database, the ports
 * it wants — into the paths and values every other platform module used to work
 * out for itself. Before this, five modules each resolved a piece from
 * `process.env` and the filesystem at call time, which is why there was nowhere
 * to hand a different project.
 *
 * IDENTITY IS FIXED, LOCATION IS NOT
 *
 * `name` and `databaseName` are decided when the program is built and never
 * change while it runs. The profile *directory* is a different kind of thing:
 * `${NAME}_HOME` moves it, and the test suite moves it between assertions to
 * prove profiles are isolated. So identity is a value and paths are functions
 * that re-read the environment on every call.
 *
 * Caching a path would produce the bug that comment exists to prevent: one
 * suite quietly reading another suite's database.
 *
 * NO PROJECT NAMES HERE
 *
 * Nothing in this file, or anywhere else under `platform/`, may name a specific
 * project. `resolvePlatform` is handed an identity; where that identity comes
 * from is the application's business.
 */

import envPaths from "env-paths";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

/** What a project tells the platform about itself. */
export interface ProjectIdentity {
  /**
   * Names the profile directory, the database, and the `_HOME` override.
   *
   * Lower-case, no spaces: it becomes a directory name, a Postgres database
   * name and — upper-cased — an environment variable.
   */
  name: string;

  /** The application database. Defaults to `name`. */
  databaseName?: string;

  /** Service name → the port to start looking at. */
  ports: Record<string, number>;
}

/** Why the profile resolved where it did. */
export type ProfileSource = "home variable" | "platform default";

export interface PlatformConfig {
  readonly identity: ProjectIdentity;

  /** The application database's name. */
  readonly databaseName: string;

  /** The environment variable that moves the profile, e.g. `MYAPP_HOME`. */
  readonly homeVar: string;

  /**
   * The profile directory: config file, cluster, log. Back it up, move it or
   * delete it as a unit — nothing of the project's lives anywhere else.
   *
   * Resolved on every call rather than cached, so a caller can move the profile
   * between operations.
   */
  profileDir(): string;

  /** The config file. Written by the project's `init`, never hand-edited. */
  configPath(): string;

  /** Whether the home variable chose the profile, or the platform default did. */
  profileSource(): ProfileSource;

  /**
   * A short name for THIS profile, distinct from any other on the machine.
   *
   * What a destructive command asks the user to type. The full path is too long
   * to retype and the directory's own basename is no good either — the
   * platform-native default ends in a generic component ("Data" on Windows),
   * which names nothing and would be identical for every project.
   *
   * So: the default profile is named for the project, and an overridden one for
   * the directory the user chose. Two profiles on one machine therefore never
   * share a name, which is the property the confirmation depends on.
   */
  profileName(): string;

  /**
   * A path with the home directory shortened to `~`.
   *
   * Purely for display. The platform-native location is long and contains a
   * space on macOS, so raw paths make terminal output hard to scan.
   */
  displayPath(path: string): string;
}

/**
 * Build the configuration for one project.
 *
 * `env` is a parameter so a caller can resolve a second, independent profile
 * without mutating the process — which is what a test wanting two profiles at
 * once had to do before.
 */
export function resolvePlatform(
  identity: ProjectIdentity,
  env: NodeJS.ProcessEnv = process.env,
): PlatformConfig {
  const homeVar = `${identity.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_HOME`;

  const override = (): string | undefined => {
    const raw = env[homeVar];
    return raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;
  };

  const profileDir = (): string => {
    const set = override();
    // A relative value is resolved against the current directory, so
    // `X_HOME=./.dev` means what it looks like.
    if (set !== undefined) return resolve(set);

    // `suffix: ""` matters — env-paths appends "-nodejs" by default, which
    // would put user-visible data in a directory named after our implementation.
    //
    // Only the *data* directory is used. env-paths' config/cache/log/temp
    // directories would scatter the profile across four places, and `temp` in
    // particular resolves under /var/folders on macOS, which the OS reaps
    // periodically — a reaped socket directory under a running postmaster is a
    // very confusing failure.
    return envPaths(identity.name, { suffix: "" }).data;
  };

  return {
    identity,
    databaseName: identity.databaseName ?? identity.name,
    homeVar,
    profileDir,
    configPath: () => join(profileDir(), "config.json"),
    profileSource: () => (override() !== undefined ? "home variable" : "platform default"),
    profileName: () => {
      const set = override();
      if (set === undefined) return identity.name;
      // A root path ("C:\", "/") has no basename. Falling back to the project
      // name keeps the confirmation answerable rather than asking for "".
      const chosen = basename(resolve(set));
      return chosen === "" ? identity.name : chosen;
    },
    displayPath: (path: string): string => {
      const home = homedir();
      return path === home || path.startsWith(`${home}${sep}`)
        ? `~${path.slice(home.length)}`
        : path;
    },
  };
}
