/**
 * The MCP server lifecycle, with no knowledge of what it serves.
 *
 * Everything here is true of any launch-mcp app: construct a server, register
 * whatever tools were handed in, connect a transport, stay up until the client
 * disconnects, and give the app one chance to release anything holding the
 * event loop open.
 *
 * Tools arrive as registrar functions rather than being defined here. That is
 * the entire boundary — this file cannot name a costingly tool, and the
 * compiler will say so if it ever tries.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { query } from "../../data/db/queries.js";

/** Registers one tool against the server it is handed. */
export type ToolRegistrar = (server: McpServer) => void | Promise<void>;

export interface McpRuntimeOptions {
    /** Server name reported in the initialize result. */
    name: string;
    version: string;
    description: string;
    /** What the SERVER is for, above any individual tool. */
    instructions: string;
    /** Applied in order — the order the client sees the tools in. */
    registrars: readonly ToolRegistrar[];
    /**
     * Released after the client disconnects, before run() resolves. For
     * anything the app started that refs the event loop.
     */
    onShutdown?: () => Promise<void>;
}

export class McpRuntime {

    private _server: McpServer;
    private _registrars: readonly ToolRegistrar[];
    private _onShutdown: (() => Promise<void>) | undefined;

    constructor(options: McpRuntimeOptions) {
        this._registrars = options.registrars;
        this._onShutdown = options.onShutdown;
        this._server = new McpServer(
            {
                name: options.name,
                version: options.version,
                description: options.description,
            },
            { instructions: options.instructions },
        );
    }

    /** Connects the local McpServer. */
    async connect(transport: Transport): Promise<void> {
        await this._server.connect(transport);
    }

    /**
     * Register, connect, and stay running until the client disconnects.
     */
    async run(transport: Transport): Promise<void> {
        for (const register of this._registrars) await register(this._server);

        // Installed BEFORE connecting. A client that disconnects while connect()
        // is still settling would fire onclose against a hook that does not exist
        // yet, and this method would then wait forever for an event already past.
        const closed = new Promise<void>((resolve) => {
            this._server.server.onclose = () => resolve();
        });

        await this.connect(transport);

        this.warmUp();

        // Nothing past this line runs until the client closes the connection.
        await closed;

        // The link server, if one was started, holds a listening socket — which
        // refs the event loop and stops this process exiting. Measured: without
        // this the process outlived its client by minutes, waiting on the link
        // server's own ten-minute idle timer, exactly the zombie behaviour the
        // stdin EOF handling exists to prevent.
        if (this._onShutdown !== undefined) await this._onShutdown();
    }

    /**
     * Start the database without waiting for it.
     *
     * On a fresh install the first connection runs initdb, starts the cluster,
     * creates the database and applies the schema — around five seconds. This
     * server is useless without all of that, so there is no reason to defer it
     * until someone asks a question.
     *
     * But it must not block the handshake either. Awaiting it before connect()
     * would put five seconds between Claude Desktop spawning this process and
     * the tool list appearing, and a database that could not start at all would
     * leave the user with a dead extension and no way to ask what went wrong.
     *
     * So it is started, not awaited. getDriver() caches the promise, so a tool
     * call arriving mid-warm-up joins this same work rather than beginning a
     * second copy — and a failed attempt is deliberately un-cached, so that call
     * retries and reports the real error through isError, where the model can
     * pass it on. Nothing here is load-bearing; it only moves the cost earlier.
     */
    private warmUp(): void {
        void query("SELECT 1").catch((error: unknown) => {
            // stderr, never stdout: stdout is the protocol channel. Claude
            // Desktop captures this into mcp-server-costingly.log.
            console.error(
                "[costingly] database not ready at startup:",
                error instanceof Error ? error.message : error,
            );
        });
    }
}
