/**
 * A PostgreSQL cluster: the directory of data, and nothing that runs.
 *
 * In PostgreSQL's own vocabulary a *cluster* is a `PGDATA` directory holding a
 * set of databases — created once by `initdb`, and inert on its own. The
 * postmaster that serves it is a *server*, and lives in pg-server-service.ts.
 *
 * The separation is not tidiness. One function that both created a cluster and
 * started a server meant every caller that only wanted to start one could
 * silently create one instead, and `initdb` on a user's disk is not something
 * to do by accident. Two services, and the capability is visible in the import.
 *
 * Knows nothing about profiles, config files or any particular project: it is
 * handed a directory and the parameters a cluster needs.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandResult } from "../../services/os-service.js";
import type { PgBinariesService } from "./pg-binaries-service.js";

/** What `initdb` needs to know. Values, never a config object. */
export interface CreateClusterOptions {
  /** The bootstrap superuser and its password. */
  superuser: { user: string; password: string };
  /** Address the postmaster will listen on. Loopback only — never 0.0.0.0. */
  host: string;
  /** TCP port, written into postgresql.conf. Decided by the caller. */
  port: number;
}

export class PgClusterService {
  /**
   * @param dataDir PGDATA. Belongs to Postgres alone — nothing else may write here.
   * @param binaries where the executables are, and how to run one.
   */
  constructor(
    private readonly dataDir: string,
    private readonly binaries: PgBinariesService,
  ) {}

  /**
   * Is there a cluster in this directory?
   *
   * `PG_VERSION` is the file `initdb` writes to mark a directory as a cluster,
   * so its presence IS the definition rather than a proxy for it. A stat rather
   * than `pg_ctl status`, because this must answer when the binaries are
   * missing — and because "does a cluster exist" is a question about files,
   * not about a process.
   */
  async exists(): Promise<boolean> {
    try {
      await stat(join(this.dataDir, "PG_VERSION"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create the cluster. The only thing in the platform that runs `initdb`.
   *
   * Listens on loopback TCP with scram-sha-256. Peer authentication is not an
   * option: it needs a unix socket, and node-postgres only treats a host as a
   * socket path when it starts with "/" — which a Windows path never does. One
   * transport on every platform is what keeps Windows from being the untested
   * path.
   *
   * NOT idempotent by itself — `initdb` fails on a non-empty directory. Callers
   * that may be racing check `exists()` again on failure; see the sequence in
   * the domain's install.
   */
  async create(options: CreateClusterOptions): Promise<void> {
    const { initdb } = await this.binaries.locate();

    await mkdir(this.dataDir, { recursive: true });

    // initdb takes the superuser password from a file rather than a flag, so it
    // never appears in the process list. Written beside the data directory — in
    // the profile, which is already 0700 — rather than the system temp
    // directory, which is world-readable on unix.
    //
    // Removed in a `finally`: a failed initdb must not leave a plaintext
    // password on disk, and that is exactly the path where it would.
    const passwordFile = join(this.dataDir, "..", `.initdb-${randomUUID()}`);
    let result: CommandResult;
    try {
      await writeFile(passwordFile, `${options.superuser.password}\n`, { mode: 0o600 });

      result = await this.binaries.run(initdb, [
        `--pgdata=${this.dataDir}`,
        `--username=${options.superuser.user}`,
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
        `Could not create the database cluster at ${this.dataDir}.\n\n${result.stderr.trim()}`,
      );
    }

    await this.writeManagedConfig(options);
  }

  /**
   * The settings we insist on, written into the files rather than passed as
   * flags — so they hold even if someone runs `pg_ctl` by hand.
   */
  private async writeManagedConfig(options: CreateClusterOptions): Promise<void> {
    const configPath = join(this.dataDir, "postgresql.conf");
    const existing = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${existing}\n` +
        `# --- managed ------------------------------------------------------------\n` +
        `# Loopback only. Binding anything else would put private data on the network.\n` +
        `listen_addresses = ${quoteConfigValue(options.host)}\n` +
        `port = ${options.port}\n` +
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
      join(this.dataDir, "pg_hba.conf"),
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
