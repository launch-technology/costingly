/**
 * A local PostgreSQL cluster, managed by us.
 *
 * This module knows nothing about costingly. It is handed a `ClusterConfig` and
 * drives PostgreSQL against it — which is what makes it liftable into any other
 * project that needs an embedded Postgres without inheriting a profile system,
 * a config file format or a CLI. `db/server.ts` is the costingly-shaped binding
 * that supplies the config; everything platform-specific lives here.
 *
 * Two deliberate choices shape this file:
 *
 *   We drive `pg_ctl`, not the `embedded-postgres` wrapper. That wrapper spawns
 *   Postgres as a *child* of the Node process and watches its stderr to detect
 *   readiness, so the server dies with whichever process started it. `pg_ctl`
 *   daemonises properly: the server outlives the command that started it, which
 *   is the whole point of "start once, stay running" — a CLI sync and a
 *   long-lived MCP server have to share one cluster.
 *
 *   Every binary is run with file-backed stdio, never pipes. See `run` below;
 *   this is not a style preference but the difference between working and
 *   hanging forever.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Postgres major version these binaries provide. */
export const PG_MAJOR = 18;

export type ServerState =
  /** Cluster exists and the postmaster is accepting connections. */
  | "running"
  /** Cluster exists on disk but nothing is running. */
  | "stopped"
  /** No cluster yet — `initdb` has never run. */
  | "uninitialised";

/**
 * Everything this module needs to know. No globals, no ambient lookups: two
 * clusters can exist side by side, which is what the test suite relies on and
 * what makes the module reusable.
 */
export interface ClusterConfig {
  /** PGDATA. Belongs to Postgres alone — nothing else may write here. */
  dataDir: string;
  /** The database created inside the cluster, beside the default `postgres`. */
  databaseName: string;
  /** Postmaster log. `pg_ctl start` redirects the server's output here. */
  logPath: string;
  /** Directory for the unix socket. A sibling of `dataDir`, never inside it. */
  socketDir: string;
  /** OS user the cluster is owned by and authenticated as, via `peer`. */
  user: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
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

/** Module-level, not per-cluster: the binaries are the same for every cluster. */
let cachedBinaries: Promise<Binaries> | undefined;

async function binaries(): Promise<Binaries> {
  if (cachedBinaries) return cachedBinaries;

  cachedBinaries = (async () => {
    const key = `${process.platform}-${process.arch}`;
    const specifier = BINARY_PACKAGES[key];

    if (specifier === undefined) {
      throw new Error(
        `No PostgreSQL build is available for ${key}.\n\n` +
          `Supported: ${Object.keys(BINARY_PACKAGES).join(", ")}.`,
      );
    }

    try {
      return (await import(specifier)) as Binaries;
    } catch (error) {
      throw new Error(
        `Could not load the PostgreSQL binaries (${specifier}).\n\n` +
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

/**
 * Run a Postgres binary and return its exit code rather than throwing on it.
 *
 * WHY FILES AND NOT PIPES
 *
 * `execFile` — and any `spawn` with `stdio: "pipe"` — resolves on the child's
 * `close` event, which waits for the process to exit AND for its stdio to reach
 * EOF. `pg_ctl start` launches a postmaster that inherits copies of those pipe
 * handles and holds them for the life of the cluster, so EOF never arrives and
 * the call hangs forever even though `pg_ctl` exited in under a second.
 *
 * On Windows this is unavoidable: `CreateProcess` with `bInheritHandles=TRUE`
 * duplicates every inheritable handle, so the pipes survive even though
 * `pg_ctl -l` reassigns the postmaster's standard streams. Unix escapes today
 * only because of that reassignment — drop `-l` and the same hang appears there.
 * So this is applied to every call rather than hidden behind a platform check.
 *
 * Files have no EOF to wait for. The postmaster inherits a file handle nobody
 * is blocked on, and `exit` is the whole story.
 */
async function run(file: string, args: readonly string[]): Promise<RunResult> {
  const base = join(tmpdir(), `pgcluster-${process.pid}-${randomUUID()}`);
  const outPath = `${base}.out`;
  const errPath = `${base}.err`;

  // Unique per call, deliberately. The postmaster keeps its inherited handles
  // for hours, so a fixed path would mean the next start opens `"w"` — truncate
  // on open — against a file another process still holds.
  const out = await open(outPath, "w");
  let err: Awaited<ReturnType<typeof open>> | undefined;

  try {
    err = await open(errPath, "w");

    const child = spawn(file, [...args], {
      // initdb and pg_ctl read LC_* and would fail or produce unparseable
      // output under an exotic locale. Pin it.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", out.fd, err.fd],
    });

    // `error` matters as much as `exit`: a missing binary emits the former and
    // never the latter, which would hang exactly like the bug this replaces.
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (c) => resolve(c ?? 1));
    });

    return {
      code,
      stdout: await readFile(outPath, "utf8"),
      stderr: await readFile(errPath, "utf8"),
    };
  } finally {
    await out.close().catch(() => {});
    await err?.close().catch(() => {});
    // Best effort: Node opens with FILE_SHARE_DELETE so this succeeds even
    // while the postmaster holds the handle. If it ever does not, a uniquely
    // named file in the temp directory is the OS's problem, not ours.
    await unlink(outPath).catch(() => {});
    await unlink(errPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The cluster
// ---------------------------------------------------------------------------

export class PostgresCluster {
  constructor(private readonly config: ClusterConfig) {}

  /** Connection string. A path-valued `host` is what selects the unix socket. */
  connectionString(database = this.config.databaseName): string {
    const user = encodeURIComponent(this.config.user);
    return `postgresql://${user}@/${database}?host=${encodeURIComponent(this.config.socketDir)}`;
  }

  async status(): Promise<ServerState> {
    const { pg_ctl } = await binaries();
    const { code } = await run(pg_ctl, ["status", "-D", this.config.dataDir]);

    if (code === 0) return "running";
    if (code === 4) return "uninitialised";
    return "stopped";
  }

  /**
   * Start the postmaster, creating the cluster first if it does not exist.
   *
   * Idempotent, and safe when several commands run at once: both the initdb and
   * the start path re-check the real state after a failure, so the process that
   * loses a race succeeds anyway rather than reporting a spurious error.
   */
  async ensureRunning(): Promise<void> {
    const state = await this.status();
    if (state === "running") return;

    if (state === "uninitialised") {
      try {
        await this.initialise();
      } catch (error) {
        // Another process may have created the cluster while we were trying to.
        if ((await this.status()) === "uninitialised") throw error;
      }
    }

    // The socket directory is ours to create — Postgres will not make it.
    await mkdir(this.config.socketDir, { recursive: true, mode: 0o700 });

    const { pg_ctl } = await binaries();
    const result = await run(pg_ctl, [
      "start",
      "-D",
      this.config.dataDir,
      "-l",
      this.config.logPath,
      // Wait for "ready to accept connections" instead of returning immediately,
      // so the caller can connect the moment this resolves.
      "-w",
      "-t",
      "60",
    ]);

    if (result.code === 0) return;

    // Lost a start race, or it came up between our status check and now.
    if ((await this.status()) === "running") return;

    throw new Error(
      `Could not start the local database.\n\n` +
        `${(result.stderr || result.stdout).trim()}\n\n` +
        `The postmaster log may say more:\n  ${this.config.logPath}`,
    );
  }

  async stop(): Promise<boolean> {
    if ((await this.status()) !== "running") return false;

    const { pg_ctl } = await binaries();
    // `fast` rolls back open transactions and disconnects clients rather than
    // waiting for them to finish, which for a personal database is what anyone
    // asking to stop the server means.
    const result = await run(pg_ctl, [
      "stop",
      "-D",
      this.config.dataDir,
      "-m",
      "fast",
      "-w",
      "-t",
      "60",
    ]);

    if (result.code !== 0 && (await this.status()) === "running") {
      throw new Error(
        `Could not stop the local database.\n\n${(result.stderr || result.stdout).trim()}`,
      );
    }
    return true;
  }

  /**
   * Create the database inside the cluster if it is missing.
   *
   * Returns true when it created one. Connects to the always-present `postgres`
   * database to do it, since you cannot create a database from inside itself.
   */
  async ensureDatabase(): Promise<boolean> {
    const pgPkg = (await import("pg")).default;
    const client = new pgPkg.Client({ connectionString: this.connectionString("postgres") });

    await client.connect();
    try {
      const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
        this.config.databaseName,
      ]);
      if (existing.rowCount === 1) return false;

      // No parameters possible in CREATE DATABASE. The name is our own constant,
      // not user input, but quote it properly regardless.
      await client.query(`CREATE DATABASE "${this.config.databaseName.replace(/"/g, '""')}"`);
      return true;
    } finally {
      await client.end();
    }
  }

  /**
   * Create the cluster.
   *
   * Peer authentication on the socket and no TCP listener at all: the user's OS
   * identity is the credential, so there is no password anywhere in the system.
   */
  private async initialise(): Promise<void> {
    const { initdb } = await binaries();

    assertSocketPathFits(this.config.socketDir);
    await mkdir(this.config.dataDir, { recursive: true });

    const result = await run(initdb, [
      `--pgdata=${this.config.dataDir}`,
      `--username=${this.config.user}`,
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
        `Could not create the database cluster at ${this.config.dataDir}.\n\n${result.stderr.trim()}`,
      );
    }

    // Written into postgresql.conf rather than passed on the command line, so
    // the settings hold even if someone runs pg_ctl by hand.
    const configPath = join(this.config.dataDir, "postgresql.conf");
    const existing = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${existing}\n` +
        `# --- managed ------------------------------------------------------------\n` +
        `# No TCP listener: this database is reachable only through the unix socket\n` +
        `# below, in a directory only this user can read.\n` +
        `listen_addresses = ''\n` +
        `unix_socket_directories = ${quoteConfigValue(this.config.socketDir)}\n` +
        `unix_socket_permissions = 0700\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Quote a value for a postgresql.conf string setting.
 *
 * The config parser processes escape sequences inside single-quoted values, so a
 * raw Windows path is destroyed before Postgres ever looks for it: the `\t` of
 * `C:\tmp\...` becomes a literal tab and unrecognised escapes lose their
 * backslash, leaving a directory that cannot exist. Doubling the backslashes
 * gets the original path back out the other side.
 *
 * Not Windows-only. A backslash or an apostrophe is a legal character in a unix
 * filename too, and either would corrupt the file the same way.
 */
export function quoteConfigValue(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * Guard against a socket path too long for the platform's `sockaddr_un`.
 *
 * macOS allows 104 bytes and Linux 108, for the *full* path including the
 * `.s.PGSQL.5432` suffix Postgres appends. Blowing that limit produces a bind
 * failure buried in the postmaster log, which is a miserable thing to debug —
 * so check up front and say exactly what to do about it.
 */
export function assertSocketPathFits(directory: string): void {
  const full = join(directory, ".s.PGSQL.5432");
  const limit = 100;
  if (Buffer.byteLength(full) > limit) {
    throw new Error(
      `The database socket path is too long for this platform:\n  ${full}\n\n` +
        `Unix sockets are limited to about ${limit} characters. Move the cluster somewhere shorter.`,
    );
  }
}
