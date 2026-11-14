#!/usr/bin/env node
/**
 * The Costingly extension for Claude Desktop — the executable Claude Desktop
 * launches, and the only thing in the bundle.
 *
 * It connects Claude Desktop to the MCP endpoint the Costingly desktop app
 * serves on this machine (relay.service.ts). It holds no database, no Plaid
 * client and no tools of its own beyond the one it offers when the app cannot
 * be reached. It never starts the app.
 *
 * NOTHING HERE MAY WRITE TO STDOUT. It is the protocol channel, and a single
 * stray line corrupts the session. Diagnostics go to stderr, which Claude
 * Desktop captures into its per-extension log — and never include the token.
 *
 * Imports nothing from the desktop app: the folder the app writes to and the
 * file it writes are the platform's, shared by both (platform/app-dir.ts,
 * platform/connection-file.ts).
 */

import { existsSync } from "node:fs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { connectionPath } from "../../platform/app-dir.js";
import { ConnectionFile } from "../../platform/connection-file.js";
import { resolvePlatform } from "../../platform/platform-config.js";
import { configureLog, formatLine, log } from "../../platform/runtime/log.js";
import { connectToApp } from "./app.client.js";
import { DiscoveryService, settingsFromEnvironment } from "./discovery.service.js";
import { RelayService } from "./relay.service.js";
import { mcpbVersion } from "./version.js";

/** How long one request to the app may take: longer than the app's slowest tool. */
const APP_CALL_TIMEOUT_MS = 120_000;

// Every level to stderr, Claude Desktop's log for this extension. No file: the
// extension lives as long as Claude Desktop does and owns nothing on disk.
configureLog((level, message) => process.stderr.write(`${formatLine(level, message)}\n`));

const version = mcpbVersion();
const identity = { name: "costingly-mcpb", version };

// The same project identity the app resolves its profile from, so this process
// looks in the same folder — including when COSTINGLY_HOME has moved it.
const profile = resolvePlatform({ name: "costingly", ports: {} });
const path = connectionPath(profile);
const connectionFile = new ConnectionFile(path);

const discovery = new DiscoveryService({
  settings: settingsFromEnvironment,
  connection: async () => (existsSync(path) ? connectionFile.load() : "absent"),
});

const relay = new RelayService({
  discover: () => discovery.discover(),
  connect: (endpoint) => connectToApp(endpoint, identity, APP_CALL_TIMEOUT_MS),
  identity: { name: "costingly", version },
  log,
});

const transport = new StdioServerTransport();

// StdioServerTransport listens for 'data' and 'error' on stdin, but not for EOF
// — so when Claude Desktop hangs up, nothing notices unless this does. Closing
// the transport closes the server, which closes the relay (relay.service.ts).
process.stdin.once("end", () => void transport.close());

try {
  await relay.start(transport);
  log.info(`costingly extension ${version} ready`);
} catch (error) {
  // Nothing was answered, so Claude Desktop's log is the only channel.
  process.stderr.write(`[costingly] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
