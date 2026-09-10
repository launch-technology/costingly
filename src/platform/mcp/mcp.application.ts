/**
 * An MCP server as an Application.
 *
 * Everything true of any MCP server and nothing true of a particular one:
 * construct the server, register whatever tools the subclass supplies, connect
 * a transport, stay up until the client disconnects, and release on the way out.
 *
 * A concrete server is a subclass supplying three things — what it is called,
 * what it is for, and its tools. Tools arrive as registrar functions rather than
 * being defined here, which is the whole boundary: this file cannot name a
 * concrete tool, and the compiler says so if it ever tries.
 *
 * The transport is injected rather than created, so the same application can be
 * driven over stdio by a desktop host and over an in-memory pair by a test.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { Application } from "../runtime/application.js";
import { ResourceScope } from "../runtime/resource-scope.js";

/** Registers one tool against the server it is handed. */
export type ToolRegistrar = (server: McpServer) => void | Promise<void>;

/** What a client is told about the server itself, above any individual tool. */
export interface McpServerInfo {
  name: string;
  version: string;
  description: string;
  /**
   * Returned in the initialize result. The only place to say what the SERVER is
   * for, and where the relationship between its tools belongs — no tool's own
   * description is the right place to explain the others.
   */
  instructions: string;
}

export abstract class McpApplication implements Application {
  private server: McpServer | undefined;
  private closed: Promise<void> | undefined;

  /** Released after the client disconnects, most recent first. */
  protected readonly scope = new ResourceScope();

  constructor(private readonly transport: Transport) {}

  // --- what a subclass supplies --------------------------------------------

  protected abstract info(): McpServerInfo;

  /** Applied in order — the order the client lists them in. */
  protected abstract tools(): readonly ToolRegistrar[];

  /**
   * Compose whatever this server needs, and register it for release.
   *
   * Runs first, before the MCP server exists, so a failure here never leaves a
   * half-connected client.
   */
  protected async configure(): Promise<void> {}

  /**
   * Start slow work early WITHOUT awaiting it.
   *
   * Called after the transport is connected. Anything expensive that a first
   * tool call would otherwise pay for belongs here — but it must not block, or
   * it delays the handshake and the tool list with it.
   */
  protected warmUp(): void {}

  // --- Application ----------------------------------------------------------

  get name(): string {
    return this.info().name;
  }

  async start(): Promise<void> {
    await this.configure();

    const info = this.info();
    this.server = new McpServer(
      { name: info.name, version: info.version, description: info.description },
      { instructions: info.instructions },
    );

    for (const register of this.tools()) await register(this.server);

    // Installed BEFORE connecting. A client that disconnects while connect() is
    // still settling would fire onclose against a hook that does not exist yet,
    // and run() would then wait forever for an event already past.
    this.closed = new Promise<void>((resolve) => {
      const server = this.server;
      if (server !== undefined) server.server.onclose = () => resolve();
    });

    await this.server.connect(this.transport);
  }

  /** Stay running until the client closes the connection. */
  async run(): Promise<void> {
    if (this.closed === undefined) throw new Error("run() before start()");
    this.warmUp();
    await this.closed;
  }

  async stop(): Promise<void> {
    await this.scope.closeAll();
  }
}
