#!/usr/bin/env node
/**
 * costingly's MCP server — the executable Claude Desktop launches.
 *
 * The bundle's manifest points here directly. This file chooses the transport,
 * says how a failure should read to a model's host, and launches. What the
 * server does is costingly-mcp.application.ts; how a process is run is the
 * host's.
 *
 * Deliberately separate from the CLI. This entry point shares no code with
 * apps/cli, which is what lets the bundle ship without it.
 *
 * NOTHING HERE MAY WRITE TO STDOUT. It is the protocol channel, and a single
 * stray line corrupts the session. Diagnostics go to stderr, which the host
 * captures into its per-server log.
 *
 * Deliberately no .env loading, unlike the CLI. A bundled install gets its
 * credentials from the extension's settings, which the host substitutes into
 * this process's environment. There is no working directory a .env would
 * sensibly belong to — the process is spawned by a desktop app, not from a
 * shell someone is standing in.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ApplicationHost } from "../../platform/runtime/application-host.js";
import { packageVersion } from "../../platform/package.js";
import { CostinglyMcpApplication } from "./costingly-mcp.application.js";

const transport = new StdioServerTransport();

// StdioServerTransport listens for 'data' and 'error' on stdin, but not for EOF
// — so when the client hangs up, the transport never notices and never fires
// onclose. Without this, the server waits forever for a disconnect that already
// happened, and the process lingers until pg's idle timer drains the event loop.
process.stdin.once("end", () => void transport.close());

await ApplicationHost.launch(new CostinglyMcpApplication(packageVersion(), transport), {
  // A failure this early means no tool call ever ran, so there is no result to
  // carry it — the host's log is the only channel.
  reportError: (error) => ({
    message: `[costingly] fatal: ${error instanceof Error ? error.message : String(error)}`,
    exitCode: 1,
  }),
});
