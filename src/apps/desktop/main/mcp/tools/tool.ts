/**
 * What a tool is: one answer to a model's call.
 *
 * The MCP counterpart of shared/controller.ts. A controller receives the
 * window's calls; a tool receives a model's. Each is a class handed what it
 * needs through its constructor, holds no logic worth testing on its own, and
 * does three things: name itself, describe itself to the model, and ask its
 * dependencies for the answer.
 *
 * A tool registers itself against a host rather than being registered by one,
 * so the description, the input schema and the handler — which belong
 * together — stay in one place. The host is the one method of the SDK's
 * server a tool needs, which is what lets the route wrap every handler once
 * (see ../mcp-route.ts) without the tools knowing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Where a tool registers itself. The SDK's server satisfies this; so does a wrapper around it. */
export type ToolHost = Pick<McpServer, "registerTool">;

export interface Tool {
  /** The tool's name, as a client lists it. */
  readonly name: string;
  register(host: ToolHost): void;
}
