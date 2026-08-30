#!/usr/bin/env node
/**
 * costingly's MCP server — the executable Claude Desktop launches.
 *
 * The bundle's manifest points here directly. Everything process-wide happens
 * once, in this file: the composition root below, the stdio transport, and
 * closing the pool on the way out. The server itself is in server.ts and knows
 * nothing about how it was started.
 *
 * Deliberately separate from the CLI. This entry point shares no code with
 * apps/cli, which is what lets the bundle ship without it.
 *
 * NOTHING HERE MAY WRITE TO STDOUT. It is the protocol channel, and a single
 * stray line corrupts the session. Diagnostics go to stderr, which the host
 * captures into its per-server log.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDb, setMigrationSource } from "../../data/db/bootstrap.js";
import { loadMigrations } from "../../data/db/migrations.js";
import { setPublicDir } from "../../web/server.js";
import { packageVersion, publicDir } from "../../core/package.js";
import { CostinglyMcpServer } from "./server.js";

// The composition root. data/db and web/ each declare a port — "something must
// give me the migrations", "something must tell me where the static page is" —
// and this is the one place both are answered. Registering the loader here lets
// the driver migrate the database itself on the first connection, which is the
// only option in a bundled install: there is no terminal to run `migrate` in,
// and no hook between "user installs" and "user asks a question".
setMigrationSource(loadMigrations);
setPublicDir(publicDir);

/**
 * Exit quietly when the pipe closes.
 *
 * Under MCP, stdout closing means the client is gone. Without this, Node raises
 * an unhandled EPIPE and prints a stack trace to a log nobody asked for.
 */
function ignoreEpipe(): void {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
}

/**
 * Deliberately no .env loading, unlike the CLI.
 *
 * A bundled install gets its credentials from the extension's settings, which
 * the host substitutes into this process's environment. There is no working
 * directory a .env would sensibly belong to — the process is spawned by a
 * desktop app, not from a shell someone is standing in.
 */
async function main(): Promise<void> {
  ignoreEpipe();

  const transport = new StdioServerTransport();

  // StdioServerTransport listens for 'data' and 'error' on stdin, but not for
  // EOF — so when the client hangs up, the transport never notices and never
  // fires onclose. Without this, the server waits forever for a disconnect that
  // already happened, and the process lingers until pg's idle timer drains the
  // event loop.
  process.stdin.once("end", () => void transport.close());

  // Returns when the client disconnects.
  await new CostinglyMcpServer(packageVersion()).run(transport);
}

main()
  .catch((error: unknown) => {
    // stderr, never stdout. A failure this early means no tool call ever ran,
    // so there is no result to carry it — the host's log is the only channel.
    console.error("[costingly] fatal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Safe unconditionally: closeDb() returns early when nothing was opened.
    await closeDb();
  });
