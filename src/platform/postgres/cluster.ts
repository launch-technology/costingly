/**
 * A local PostgreSQL cluster, managed by us.
 *
 * This module knows nothing about the project. It is handed a `ClusterConfig` and
 * drives PostgreSQL against it — which is what makes it liftable into any other
 * project that needs an embedded Postgres without inheriting a profile system,
 * a config file format or a CLI. `server.ts` is the profile-shaped binding
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
  /** Address the postmaster listens on. Loopback only — never 0.0.0.0. */
  host: string;
  /** TCP port. Allocated by the caller; the cluster is told, never chooses. */
  port: number;
  /**
   * The bootstrap superuser initdb creates, and its password.
   *
   * A FUNCTION, not a value, and the laziness is load-bearing. Supplying these
   * usually means generating a password and writing it to the project's config
   * on first use — so an eager field made every cluster operation a write,
   * including `status()`, `stop()` and `runningPort()`, none of which need an
   * identity at all. A read-only health check that creates credentials as a
   * side effect of asking whether the server is up is not a health check.
   *
   * Called only where an identity is genuinely required: creating the cluster,
   * and building a connection string.
   */
  superuser: () => { user: string; password: string };
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
      // initdb and pg_ctl are console applications. A parent that HAS a console
      // lends it to them and nothing appears — which is every test run, from a
      // terminal. Claude Desktop is a GUI process with no console, so Windows
      // creates one per child: a console window flashes for every tool call,
      // stealing focus. Ignored on unix.
      windowsHide: true,
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

  /** Superuser connection string. The only identity this class knows about. */
  connectionString(database = this.config.databaseName): string {
    const { user, password } = this.config.superuser();
    return (
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
      `@${encodeURIComponent(this.config.host)}:${this.config.port}/${encodeURIComponent(database)}`
    );
  }

  /**
   * The port a running postmaster is actually listening on, or undefined.
   *
   * Read from postmaster.pid, which the server writes itself — the only
   * authoritative answer. Config records what was *allocated*, which can differ:
   * two processes starting at once both allocate before either has bound, and
   * the loser would otherwise dial a port nothing is listening on.
   */
  async runningPort(): Promise<number | undefined> {
    try {
      const pid = await readFile(join(this.config.dataDir, "postmaster.pid"), "utf8");
      // Line 4. Documented layout: pid, data directory, start time, port.
      const port = Number(pid.split(/\r?\n/)[3]?.trim());
      return Number.isInteger(port) && port > 0 ? port : undefined;
    } catch {
      return undefined;
    }
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

  /**
   * Ask the server to shut down. True if it was running and now is not.
   *
   * ALWAYS ATTEMPTS, even when `status()` says there is nothing to stop.
   * `status()` runs `pg_ctl status`, which decides by reading postmaster.pid —
   * and a data directory that was deleted under a live server has no pid file
   * while the postmaster carries on from its open handles. Short-circuiting on
   * that answer meant the one case where stopping mattered most was the case
   * where it was never tried.
   *
   * `pg_ctl` cannot do better: every `stop` form takes only `-D DATADIR` and
   * finds the postmaster through that file alone. So a caller that is about to
   * DELETE this directory must not treat "stopped" as proof — see
   * `PostgresServer.isServing()`, which asks the port instead.
   */
  async stop(): Promise<boolean> {
    const before = await this.status();
    // Nothing was ever created here, so there is no server and no pid file to
    // be wrong about.
    if (before === "uninitialised") return false;

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

    // A non-zero exit with nothing running is `pg_ctl` reporting "no server
    // running" — either it really was stopped, or its pid file is gone. Which
    // of those is true cannot be answered from here, so the honest return is
    // what the state looked like before, and the port check is what decides.
    return result.code === 0 || before === "running";
  }


  /**
   * Create the cluster.
   *
   * Listens on loopback TCP with scram-sha-256. Peer authentication is not an
   * option: it needs a unix socket, and node-postgres only treats a host as a
   * socket path when it starts with "/" — which a Windows path never does. One
   * transport on every platform is what keeps Windows from being the untested
   * path.
   */
  private async initialise(): Promise<void> {
    const { initdb } = await binaries();

    await mkdir(this.config.dataDir, { recursive: true });

    // initdb takes the superuser password from a file rather than a flag, so it
    // never appears in the process list. Written beside the data directory — in
    // the profile, which is already 0700 — rather than the system temp
    // directory, which is world-readable on unix.
    //
    // Removed in a `finally`: a failed initdb must not leave a plaintext
    // password on disk, and that is exactly the path where it would.
    const passwordFile = join(this.config.dataDir, "..", `.initdb-${randomUUID()}`);
    let result: RunResult;
    try {
      await writeFile(passwordFile, `${this.config.superuser().password}\n`, { mode: 0o600 });

      result = await run(initdb, [
        `--pgdata=${this.config.dataDir}`,
        `--username=${this.config.superuser().user}`,
        `--pwfile=${passwordFile}`,
        // Both transports authenticate. Nothing is trusted for being local.
        "--auth-local=scram-sha-256",
        "--auth-host=scram-sha-256",
        "--encoding=UTF8",
        // Explicit and machine-independent. Inheriting the user's locale makes
        // sort order differ between machines and can fail outright on an unusual
        // LANG, neither of which is worth the nicer collation.
        "--locale=C",
      ]);
    } finally {
      await unlink(passwordFile).catch(() => {});
    }

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
        `# Loopback only. Binding anything else would put bank data on the network.\n` +
        `listen_addresses = ${quoteConfigValue(this.config.host)}\n` +
        `port = ${this.config.port}\n` +
        `# No unix socket at all. Left unset, Postgres falls back to a compiled\n` +
        `# default — /tmp on most unix builds — which is world-writable and would\n` +
        `# make the platforms diverge again. Nothing connects over a socket:\n` +
        `# node-postgres cannot use one on Windows, which is why we are on TCP.\n` +
        `unix_socket_directories = ''\n`,
    );

    // Replaced wholesale rather than appended: the FIRST matching line in
    // pg_hba wins, so a rule added at the end can never override a permissive
    // default written above it.
    await writeFile(
      join(this.config.dataDir, "pg_hba.conf"),
      `# Managed automatically. First match wins, so the rejections come last.\n` +
        `local   all   all                  scram-sha-256\n` +
        `host    all   all   127.0.0.1/32   scram-sha-256\n` +
        `host    all   all   ::1/128        scram-sha-256\n` +
        `# Not loopback: refused outright, whatever listen_addresses happens to say.\n` +
        `host    all   all   0.0.0.0/0      reject\n` +
        `host    all   all   ::/0           reject\n`,
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

