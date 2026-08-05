/**
 * .env discovery.
 *
 * Until now the tool was always run from the project directory, so `.env` was
 * always in the cwd. A global binary breaks that assumption, so resolution is
 * layered (highest precedence first):
 *
 *   1. real environment variables   dotenv never overwrites an existing key,
 *                                   so `PLAID_ENV=sandbox costingly ...` works
 *   2. --config <path>              explicit; fails loudly if missing
 *   3. ./.env                       cwd — preserves the old behaviour exactly
 *   4. <packageRoot>/.env           makes the binary work from anywhere
 *   5. ~/.config/costingly/.env     what `costingly init` writes
 *
 * dotenv accepts an array of paths and keeps the FIRST value it sees for a key,
 * so 3 and 4 are one call with cwd winning.
 *
 * Note the difference between install modes: `npm link` symlinks the working
 * tree, so (4) finds the project's real .env. `npm install -g .` copies a packed
 * tarball which deliberately contains no .env — there, use real environment
 * variables or --env-file.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { packageEnvPath, packageRoot } from "./paths.js";
import { CliError } from "./errors.js";

/**
 * Where `costingly init` writes, and the last place loadEnv() looks.
 *
 * This is the only candidate that exists on a machine with no project
 * directory — the `npx costingly` case, where neither ./.env nor a packaged
 * .env is present. XDG_CONFIG_HOME is honoured, matching how dataDir() honours
 * XDG_DATA_HOME.
 */
export function userConfigPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, "costingly", ".env");
}

export interface LoadedEnv {
  /** Absolute path of the file that supplied values, or null if none existed. */
  path: string | null;
}

let loaded: LoadedEnv = { path: null };

/** Where the values came from. For the help banner's diagnostics. */
export function loadedEnvPath(): string | null {
  return loaded.path;
}

/**
 * Load environment files. Call once, before anything reads config.
 *
 * Finding no file is not an error: `keygen` and `--help` must work before setup
 * exists, and src/config.ts validates lazily for exactly that reason.
 */
export function loadEnv(envFile?: string | undefined): void {
  // `quiet` suppresses dotenv's optional startup banner. It does not fire in
  // this setup, but it writes to stdout when it does — which would corrupt
  // `costingly status --json | jq`.
  if (envFile !== undefined && envFile.trim() !== "") {
    const path = resolve(envFile);
    if (!existsSync(path)) {
      throw new CliError(`--config file not found: ${path}`);
    }
    loadDotenv({ path, quiet: true });
    loaded = { path };
    return;
  }

  const cwdEnv = join(process.cwd(), ".env");
  const candidates = [cwdEnv];
  // Skip the duplicate when the cwd IS the package root (the common case when
  // working in the project directory).
  if (process.cwd() !== packageRoot) candidates.push(packageEnvPath);
  // Appended last on purpose: adding it cannot change how any existing setup
  // resolves, only give an answer where there previously was none.
  candidates.push(userConfigPath());

  const found = candidates.filter((candidate) => existsSync(candidate));
  if (found.length > 0) {
    loadDotenv({ path: found, quiet: true });
    loaded = { path: found[0] ?? null };
  }
}

/**
 * Pre-scan argv for --config.
 *
 * Commander declares the option too (so it shows in --help), but the value is
 * needed before parsing: the root help text renders an environment banner, and
 * loading env in a preSubcommand hook would run too late — every `--help` would
 * claim DATABASE_URL was unset.
 *
 * Named --config, NOT --env-file: `--env-file` is a Node CLI flag (v20+), and
 * node consumes it out of argv before this process ever runs, whatever its
 * position. The collision produces `node: <path>: not found` and our option
 * never fires.
 */
export function configFromArgv(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--config");
  if (index !== -1) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith("--config="));
  return inline?.slice("--config=".length);
}
