/**
 * The local PostgreSQL cluster.
 *
 * Costingly ships real Postgres binaries (PostgreSQL 18, from zonky's
 * embedded-postgres-binaries) as an ordinary npm dependency, and manages the
 * cluster itself. No Docker, nothing for the user to install, and — unlike the
 * PGlite setup this replaced — real MVCC, so a sync, a CLI read and a long-lived
 * MCP server can all touch the database at the same time.
 *
 * Two deliberate choices shape this file:
 *
 *   We drive `pg_ctl`, not the `embedded-postgres` wrapper. That wrapper spawns
 *   Postgres as a *child* of the Node process and registers a process exit hook,
 *   so the server would die the moment each CLI command finished. `pg_ctl start`
 *   daemonises properly: the server outlives the command that started it, which
 *   is the whole point of "start once, stay running". We depend on the platform
 *   binary packages directly and skip the wrapper entirely.
 *
 *   Unix socket only, never TCP. `listen_addresses` is empty, so nothing binds a
 *   port: no collision with a Postgres the user already runs, and nothing is
 *   reachable over the network. Authentication is `peer` — the OS decides who
 *   you are — so there is no database password to generate, store or leak. The
 *   socket lives in a 0700 directory owned by the user, which means the file
 *   system is the access control.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { APP_NAME, displayPath, profileDir } from "./profile.js";

/**
 * Postgres major version, and part of the cluster directory name.
 *
 * A data directory belongs to exactly one major version — Postgres refuses to
 * start against a directory written by a different one. Putting the version in
 * the path means a future upgrade creates a new cluster beside the old one
 * instead of failing with an error about `PG_VERSION`.
 */
const PG_MAJOR = 18;

/** The database inside the cluster. The cluster also has the default `postgres`. */
export const DATABASE_NAME = APP_NAME;

export type ServerState =
  /** Cluster exists and the postmaster is accepting connections. */
  | "running"
  /** Cluster exists on disk but nothing is running. */
  | "stopped"
  /** No cluster yet — `initdb` has never run. */
  | "uninitialised";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The cluster directory (PGDATA).
 *
 * Always inside the profile, never configurable separately. A second lever for
 * "put the database somewhere else" would let the config and the cluster drift
 * into different places — which is exactly how a sandbox config once ended up
 * sharing a database with a production one, under a different encryption key.
 * To move the database, move the whole profile with `COSTINGLY_HOME`.
 */
export function clusterDir(): string {
  return join(profileDir(), `pg${PG_MAJOR}`);
}

/**
 * Where the unix socket lives — a sibling of the cluster, never inside it.
 *
 * PGDATA belongs to Postgres, and `initdb` refuses to run against a directory
 * that already has anything in it.
 */
export function socketDir(): string {
  return `${clusterDir()}-run`;
}

/** Postmaster log. `pg_ctl start` redirects both stdout and stderr here. */
export function serverLogPath(): string {
  return `${clusterDir()}.log`;
}

/**
 * Connection string for the local cluster.
 *
 * The `host` parameter being a path is what tells libpq (and `pg`) to use a unix
 * socket rather than TCP.
 */
export function connectionString(): string {
  const user = encodeURIComponent(userInfo().username);
  return `postgresql://${user}@/${DATABASE_NAME}?host=${encodeURIComponent(socketDir())}`;
}

/**
 * Guard against a socket path too long for the platform's `sockaddr_un`.
 *
 * macOS allows 104 bytes and Linux 108, for the *full* path including the
 * `.s.PGSQL.5432` suffix Postgres appends. Blowing that limit produces a bind
 * failure buried in the postmaster log, which is a miserable thing to debug —
 * so check up front and say exactly what to do about it.
 */
function assertSocketPathFits(directory: string): void {
  const full = join(directory, ".s.PGSQL.5432");
  const limit = 100;
  if (Buffer.byteLength(full) > limit) {
    throw new Error(
      `The database socket path is too long for this platform:\n  ${full}\n\n` +
        `Unix sockets are limited to about ${limit} characters. Move the profile somewhere ` +
        `shorter:\n  export COSTINGLY_HOME=~/.costingly`,
    );
  }
}

// ---------------------------------------------------------------------------
// Binaries
// ---------------------------------------------------------------------------

interface Binaries {
  initdb: string;
  pg_ctl: string;
  postgres: string;
}

/**
 * Which `@embedded-postgres/*` package holds the binaries for this machine.
 *
 * These are `optionalDependencies` declaring `os`/`cpu`, so npm installs only
 * the matching one — the others are absent by design, which is why the import
 * specifier is a variable rather than eight literal imports.
 */
const BINARY_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "linux-arm": "@embedded-postgres/linux-arm",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "linux-ia32": "@embedded-postgres/linux-ia32",
  "linux-ppc64": "@embedded-postgres/linux-ppc64",
  "linux-x64": "@embedded-postgres/linux-x64",
  "win32-x64": "@embedded-postgres/windows-x64",
};

let cachedBinaries: Promise<Binaries> | undefined;

async function binaries(): Promise<Binaries> {
  if (cachedBinaries) return cachedBinaries;

  cachedBinaries = (async () => {
    const key = `${process.platform}-${process.arch}`;
    const specifier = BINARY_PACKAGES[key];

    if (specifier === undefined) {
      throw new Error(
        `costingly has no PostgreSQL build for ${key}.\n\n` +
          `Supported: ${Object.keys(BINARY_PACKAGES).join(", ")}.`,
      );
    }

    try {
      return (await import(specifier)) as Binaries;
    } catch (error) {
      throw new Error(
        `costingly could not load its PostgreSQL binaries (${specifier}).\n\n` +
          `This usually means the package was installed with install scripts disabled, or the\n` +
          `download was interrupted. Reinstalling normally fixes it:\n` +
          `  npm install ${specifier}\n\n` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })().catch((error: unknown) => {
    // Don't cache the failure — a reinstall should be picked up without
    // restarting the process.
    cachedBinaries = undefined;
    throw error;
  });

  return cachedBinaries;
}

// ---------------------------------------------------------------------------
// Running the binaries
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a Postgres binary and return its exit code rather than throwing on it.
 *
 * `pg_ctl status` uses its exit code as the answer (3 means "not running"), so a
 * non-zero exit is information here, not necessarily a failure.
 */
function run(file: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        // initdb and pg_ctl read LC_* and would fail or produce unparseable
        // output under an exotic locale. Pin it.
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).errno === "number" && !("code" in error)) {
          reject(error);
          return;
        }
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * What state the cluster is in.
 *
 * `pg_ctl status` exit codes: 0 running, 3 stopped, 4 no (or unreadable) data
 * directory. Using them directly avoids parsing human-readable output that
 * changes between releases.
 */
export async function serverStatus(): Promise<ServerState> {
  const { pg_ctl } = await binaries();
  const { code } = await run(pg_ctl, ["status", "-D", clusterDir()]);

  if (code === 0) return "running";
  if (code === 4) return "uninitialised";
  return "stopped";
}

/**
 * Create the cluster.
 *
 * Peer authentication on the socket and no TCP listener at all: the user's OS
 * identity is the credential, so there is no password anywhere in the system.
 */
async function initialiseCluster(): Promise<void> {
  const { initdb } = await binaries();
  const directory = clusterDir();
  const username = userInfo().username;

  assertSocketPathFits(socketDir());
  await mkdir(directory, { recursive: true });

  const result = await run(initdb, [
    `--pgdata=${directory}`,
    `--username=${username}`,
    "--auth-local=peer",
    // Belt and braces: nothing listens on TCP, but if that ever changed by
    // accident, host connections are refused rather than trusted.
    "--auth-host=reject",
    "--encoding=UTF8",
    // Explicit and machine-independent. Inheriting the user's locale makes
    // sort order differ between machines and can fail outright on an unusual
    // LANG, neither of which is worth the nicer collation.
    "--locale=C",
  ]);

  if (result.code !== 0) {
    throw new Error(
      `Could not create the database cluster at ${directory}.\n\n${result.stderr.trim()}`,
    );
  }

  // Written into postgresql.conf rather than passed on the command line, so the
  // settings hold even if someone runs pg_ctl by hand.
  const configPath = join(directory, "postgresql.conf");
  const existing = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    `${existing}\n` +
      `# --- costingly ---------------------------------------------------------\n` +
      `# No TCP listener: this database is reachable only through the unix socket\n` +
      `# below, in a directory only this user can read.\n` +
      `listen_addresses = ''\n` +
      `unix_socket_directories = '${socketDir()}'\n` +
      `unix_socket_permissions = 0700\n`,
  );
}

/**
 * Start the postmaster, creating the cluster first if it does not exist.
 *
 * Idempotent, and safe when several commands run at once: both the initdb and
 * the start path re-check the real state after a failure, so the process that
 * loses a race succeeds anyway rather than reporting a spurious error.
 */
export async function ensureServerRunning(): Promise<void> {
  const state = await serverStatus();
  if (state === "running") return;

  if (state === "uninitialised") {
    try {
      await initialiseCluster();
    } catch (error) {
      // Another process may have created the cluster while we were trying to.
      if ((await serverStatus()) === "uninitialised") throw error;
    }
  }

  // The socket directory is ours to create — Postgres will not make it.
  await mkdir(socketDir(), { recursive: true, mode: 0o700 });

  const { pg_ctl } = await binaries();
  const result = await run(pg_ctl, [
    "start",
    "-D",
    clusterDir(),
    "-l",
    serverLogPath(),
    // Wait for "ready to accept connections" instead of returning immediately,
    // so the caller can connect the moment this resolves.
    "-w",
    "-t",
    "60",
  ]);

  if (result.code === 0) return;

  // Lost a start race, or it came up between our status check and now.
  if ((await serverStatus()) === "running") return;

  throw new Error(
    `Could not start the local database.\n\n` +
      `${(result.stderr || result.stdout).trim()}\n\n` +
      `The postmaster log may say more:\n  ${serverLogPath()}`,
  );
}

/** Stop the postmaster. Returns false when it was not running to begin with. */
export async function stopServer(): Promise<boolean> {
  if ((await serverStatus()) !== "running") return false;

  const { pg_ctl } = await binaries();
  // `fast` rolls back open transactions and disconnects clients rather than
  // waiting for them to finish, which for a personal database is what anyone
  // typing `costingly stop` means.
  const result = await run(pg_ctl, ["stop", "-D", clusterDir(), "-m", "fast", "-w", "-t", "60"]);

  if (result.code !== 0 && (await serverStatus()) === "running") {
    throw new Error(`Could not stop the local database.\n\n${(result.stderr || result.stdout).trim()}`);
  }
  return true;
}

/**
 * Create the `costingly` database if the cluster does not have it yet.
 *
 * Uses the always-present `postgres` database to connect, since the target may
 * not exist. Split out from schema application so `init` can report the two
 * steps separately.
 */
export async function ensureDatabaseExists(): Promise<boolean> {
  const pgPkg = (await import("pg")).default;
  const client = new pgPkg.Client({
    connectionString: connectionString().replace(`/${DATABASE_NAME}?`, "/postgres?"),
  });

  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      DATABASE_NAME,
    ]);
    if (existing.rowCount === 1) return false;

    // No parameters possible in CREATE DATABASE. The name is our own constant,
    // not user input, but quote it properly regardless.
    await client.query(`CREATE DATABASE "${DATABASE_NAME.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await client.end();
  }
}

/** Human-readable summary for `costingly status`. */
export async function describeServer(): Promise<string> {
  const state = await serverStatus();
  const where = displayPath(clusterDir());
  if (state === "running") return `PostgreSQL ${PG_MAJOR} running at ${where}`;
  if (state === "stopped") return `PostgreSQL ${PG_MAJOR} stopped at ${where}`;
  return `No database yet — run \`costingly init\``;
}
