/**
 * POST /mcp — the model's endpoint. The one route behind the token.
 *
 * Every tool call arrives here; which tool is inside the body, as MCP has it.
 * The handler is mcp/mcp-handler.ts; this file only says where it lives.
 */

import { mcpHandler, type McpHandlerOptions } from "../mcp/mcp-handler.js";
import type { Route } from "./route.js";

export function mcpRoute(options: McpHandlerOptions): Route {
  return { path: "/mcp", method: "POST", access: "token", handler: mcpHandler(options) };
}
