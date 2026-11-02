/**
 * The local server's life: the token, the port, up and down.
 *
 * Three decisions, made here and nowhere else:
 *
 *   THE TOKEN IS MADE ONCE AND KEPT. A client configured today must still get
 *   in tomorrow, so the token is read from the connection file and only made
 *   new when there is none.
 *
 *   THE PORT IS STABLE, NOT FIXED. The allocator starts from the port that
 *   worked last time and moves on only when something else holds it. When it
 *   does move, that is remembered and reported: a client configured by hand
 *   has the old address, and the screen has to say so.
 *
 *   NEVER THROWS. A token that cannot be saved, a port that cannot be found
 *   and a server that will not start each become a remembered failure with
 *   its reason, for the Status screen to show and Try again to clear. An app
 *   whose endpoint failed is still an app.
 *
 * How the server listens is handed in (shell/local-http-server.ts, via the
 * composition root); this file knows no Express and no Electron.
 */

import { log } from "../../../../../platform/runtime/log.js";
import type { Connection } from "../../shared/connection-file.js";

export interface LocalServerDependencies {
  connection: {
    load(): Promise<Connection>;
    save(changes: Partial<Connection>): Promise<void>;
  };
  /** A port the server can bind, remembered for next time. Throws when none nearby is free. */
  allocatePort(): Promise<number>;
  newToken(): string;
  /** Start listening on a port with a token. Rejects if it cannot. */
  listen(port: number, token: string): Promise<void>;
  close(): Promise<void>;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
}

/** Why a start failed: decides what the next step is. */
export type LocalServerFailure = "token" | "no-port" | "listen";

export type LocalServerState =
  | { state: "running"; port: number; /** Set when the port differs from the last run's. */ movedFrom?: number }
  | { state: "stopped"; port?: number }
  | { state: "failed"; port?: number; kind: LocalServerFailure; reason: string };

export class LocalServerService {
  private current: LocalServerState = { state: "stopped" };
  private secret: string | undefined;

  constructor(private readonly deps: LocalServerDependencies) {}

  state(): LocalServerState {
    return this.current;
  }

  /** The token, once a start has read or made it. */
  token(): string | undefined {
    return this.secret;
  }

  /** Bring the server up, and say how it stands afterwards. Never throws. */
  async start(): Promise<LocalServerState> {
    if (this.current.state === "running") return this.current;
    // Read before allocating: allocating records the new port over this one.
    const previous = (await this.deps.connection.load()).port;

    try {
      this.secret ??= (await this.deps.connection.load()).token;
      if (this.secret === undefined) {
        this.secret = this.deps.newToken();
        await this.deps.connection.save({ token: this.secret });
      }
    } catch (error) {
      return this.fail("token", `the token could not be read or saved: ${this.deps.describeError(error)}`, previous);
    }

    let port: number;
    try {
      port = await this.deps.allocatePort();
    } catch (error) {
      return this.fail("no-port", this.deps.describeError(error), previous);
    }

    try {
      await this.deps.listen(port, this.secret);
    } catch (error) {
      return this.fail("listen", this.deps.describeError(error), port);
    }

    const moved = previous !== undefined && previous !== port;
    this.current = moved ? { state: "running", port, movedFrom: previous } : { state: "running", port };
    log.info(`the MCP endpoint is listening on port ${port}`);
    if (moved) log.warn(`the MCP endpoint moved from port ${previous} to ${port}; clients configured by hand need the new address`);
    return this.current;
  }

  /** Start again after a failure. A running server is left as it is. */
  async retry(): Promise<LocalServerState> {
    return this.start();
  }

  async stop(): Promise<void> {
    if (this.current.state !== "running") return;
    const { port } = this.current;
    try {
      await this.deps.close();
      log.info("the MCP endpoint stopped");
    } catch (error) {
      log.error(`the MCP endpoint did not stop cleanly: ${this.deps.describeError(error)}`);
    }
    this.current = { state: "stopped", port };
  }

  private fail(kind: LocalServerFailure, reason: string, port: number | undefined): LocalServerState {
    this.current = port === undefined ? { state: "failed", kind, reason } : { state: "failed", port, kind, reason };
    log.error(`the MCP endpoint could not start (${kind}): ${reason}`);
    return this.current;
  }
}
