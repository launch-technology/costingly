/**
 * What the local server's service needs, filled with the real thing: the
 * connection file, the port allocator pointed at it, and a token maker.
 *
 * WIRING ONLY. Listening itself is Express's (shell/local-http-server.ts) and
 * is handed in by the composition root, which is the one place that may hold
 * both a feature and the shell.
 *
 * The endpoint's default port is clear of the database's (54320) and of the
 * twenty ports above it that the allocator may walk into.
 */

import { randomBytes } from "node:crypto";

import { PortService } from "../../../../../platform/port-allocator.js";
import { connectionFile, describeError } from "../../shared/domain.adapter.js";
import type { LocalServerDependencies } from "./local-server.service.js";

/** The allocator's name for the endpoint: the key under which its port is remembered. */
export const MCP_SERVICE = "mcp";
export const MCP_DEFAULT_PORT = 54400;
const HOST = "127.0.0.1";

export function localServerDependencies(): Omit<LocalServerDependencies, "listen" | "close"> {
  const ports = new PortService({
    store: connectionFile.portStore(MCP_SERVICE),
    defaults: { [MCP_SERVICE]: MCP_DEFAULT_PORT },
    host: HOST,
  });
  return {
    connection: connectionFile,
    allocatePort: () => ports.allocate(MCP_SERVICE),
    newToken: () => randomBytes(32).toString("hex"),
    describeError,
  };
}
