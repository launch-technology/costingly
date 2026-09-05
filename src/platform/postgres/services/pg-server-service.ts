/**
 * A PostgreSQL server: the postmaster that serves one cluster.
 *
 * Starting, stopping, and the two different ways of asking whether it is up.
 * Creating the cluster it serves is pg-cluster-service.ts — this service
 * refuses rather than creates, so no caller can reach `initdb` through it.
 *
 * WHY `pg_ctl` AND NOT THE `embedded-postgres` WRAPPER
 *
 * That wrapper spawns Postgres as a *child* of the Node process and watches its
 * stderr to detect readiness, so the server dies with whichever process started
 * it. `pg_ctl` daemonises properly: the server outlives the command that
 * started it, which is the whole point of "start once, stay running" — a CLI
 * command and a long-lived MCP server have to share one cluster.
 *
 * TWO QUESTIONS THAT LOOK LIKE ONE
 *
 * `isRunning()` asks `pg_ctl`, which decides by reading `postmaster.pid` from
 * inside the data directory. `isAnswering()` opens a TCP connection.
 *
 * They can disagree, and the case where they do is the one that matters: a data
 * directory deleted under a live server has no pid file, so `pg_ctl` reports
 * "no server running" while the postmaster carries on serving from file handles
 * whose names are gone. Observed in the wild, not hypothetical. Anything about
 * to DELETE a cluster must believe `isAnswering()`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PgBinariesService } from "./pg-binaries-service.js";

/** How long to wait for a connection before calling a port dead. */
const PROBE_TIMEOUT_MS = 1_000;

/** How long `pg_ctl` may take to start or stop before we give up on it. */
const CONTROL_TIMEOUT_SECONDS = "60";

export class PgServerService {
  /**
   * @param dataDir PGDATA — how `pg_ctl` identifies which server it means.
   * @param logPath where `pg_ctl start` redirects the server's output.
   */
  constructor(
    private readonly dataDir: string,
    private readonly logPath: string,
    private readonly binaries: PgBinariesService,
  ) {}

  /**
   * Does `pg_ctl` believe a server is running here?
   *
   * Answers from `postmaster.pid`, so it is wrong in exactly one situation —
   * see the note at the top of this file. Cheap and usually right; not proof.
   */
  async isRunning(): Promise<boolean> {
    const { pg_ctl } = await this.binaries.locate();
    const { code } = await this.binaries.run(pg_ctl, ["status", "-D", this.dataDir]);
    return code === 0;
  }

  /**
   * Is something actually accepting connections on this port?
   *
   * Deliberately not a Postgres handshake: the question is whether anything
   * holds the port, and a server whose data directory was deleted may fail a
   * handshake while very much still running. Connect, then hang up.
   *
   * A refusal, a timeout, or any error is "no". This is used to decide whether
   * a delete may proceed, so the only answer that stops it is a connection that
   * actually opened.
   */
  async isAnswering(host: string, port: number): Promise<boolean> {
    const { createConnection } = await import("node:net");

    return new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      const settle = (answer: boolean): void => {
        socket.destroy();
        resolve(answer);
      };

      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once("connect", () => settle(true));
      socket.once("timeout", () => settle(false));
      socket.once("error", () => settle(false));
    });
  }

  /**
   * The port a running postmaster is actually listening on, or undefined.
   *
   * Read from `postmaster.pid`, which the server writes itself — the only
   * authoritative answer. A config records what was *allocated*, which can
   * differ: two processes starting at once both allocate before either has
   * bound, and the loser would otherwise dial a port nothing is listening on.
   */
  async runningPort(): Promise<number | undefined> {
    try {
      const pid = await readFile(join(this.dataDir, "postmaster.pid"), "utf8");
      // Line 4. Documented layout: pid, data directory, start time, port.
      const port = Number(pid.split(/\r?\n/)[3]?.trim());
      return Number.isInteger(port) && port > 0 ? port : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Start the server. Does NOT create a cluster — that is a different service.
   *
   * The port is not a parameter: it was written into postgresql.conf when the
   * cluster was created, so a server always comes back on the port its cluster
   * was built for. Passing one here would let a caller believe they had moved
   * it, which `pg_ctl start` cannot do.
   *
   * Idempotent, and safe when several processes race: the loser re-checks the
   * real state and succeeds rather than reporting a spurious failure.
   */
  async start(): Promise<void> {
    if (await this.isRunning()) return;

    const { pg_ctl } = await this.binaries.locate();
    const result = await this.binaries.run(pg_ctl, [
      "start",
      "-D",
      this.dataDir,
      "-l",
      this.logPath,
      // Wait for "ready to accept connections" instead of returning
      // immediately, so the caller can connect the moment this resolves.
      "-w",
      "-t",
      CONTROL_TIMEOUT_SECONDS,
    ]);

    if (result.code === 0) return;

    // Lost a start race, or it came up between the check above and now.
    if (await this.isRunning()) return;

    throw new Error(
      `Could not start the local database.\n\n` +
        `${(result.stderr || result.stdout).trim()}\n\n` +
        `The postmaster log may say more:\n  ${this.logPath}`,
    );
  }

  /**
   * Ask the server to shut down. True if one was running and now is not.
   *
   * ALWAYS ATTEMPTS, even when `isRunning()` says there is nothing to stop.
   * That answer comes from the pid file, and the case where it is wrong is
   * exactly the case where stopping matters most. Short-circuiting on it meant
   * the attempt was never made precisely when it was needed.
   *
   * `pg_ctl` cannot do better: every `stop` form takes only `-D DATADIR` and
   * finds the postmaster through that file alone. So a caller about to DELETE
   * this cluster must not treat a `true` here as proof — ask `isAnswering()`.
   */
  async stop(): Promise<boolean> {
    const wasRunning = await this.isRunning();

    const { pg_ctl } = await this.binaries.locate();
    // `fast` rolls back open transactions and disconnects clients rather than
    // waiting for them to finish, which for a personal database is what anyone
    // asking to stop the server means.
    const result = await this.binaries.run(pg_ctl, [
      "stop",
      "-D",
      this.dataDir,
      "-m",
      "fast",
      "-w",
      "-t",
      CONTROL_TIMEOUT_SECONDS,
    ]);

    if (result.code !== 0 && (await this.isRunning())) {
      throw new Error(
        `Could not stop the local database.\n\n${(result.stderr || result.stdout).trim()}`,
      );
    }

    // A non-zero exit with nothing running is `pg_ctl` reporting "no server
    // running" — either it really was stopped, or its pid file is gone. Which
    // of those is true cannot be answered from here.
    return result.code === 0 || wasRunning;
  }
}
