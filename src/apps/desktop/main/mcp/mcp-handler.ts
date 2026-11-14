/**
 * The handler that speaks MCP over HTTP. routes/mcp.route.ts puts it at /mcp.
 *
 * MCP's standard HTTP transport, in its stateless form: each POST is answered
 * by a server built for that request and discarded afterwards, so there are no
 * sessions to track, any number of clients can connect, and nothing survives
 * an app restart that a client could be confused by. The cost is that the app
 * cannot push a message to a client unprompted, which no tool here needs.
 *
 * NO AUTHENTICATION HERE. That is the local server's job (shell/
 * local-http-server.ts), done before this runs; this handler trusts that
 * whatever reached it was allowed to.
 *
 * ONE PLACE WATCHES EVERY TOOL CALL. Each tool registers itself against a host
 * that wraps its handler, so the observer learns the tool's name and how the
 * call ended — and nothing else: not the arguments, which may be a query
 * naming an account, and not the result, which may be rows. The tools do not
 * know they are being watched.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandler } from "express";

import type { ServerInfo } from "./server-info.js";
import type { Tool, ToolHost } from "./tools/tool.js";

/** How a tool call ended: answered, answered with an error result, or threw. */
export type ToolOutcome = "ok" | "error" | "threw";

/** The header a client may send to say who it is, e.g. `costingly-mcpb/2.0.0`. */
export const CLIENT_HEADER = "x-costingly-client";

export interface McpHandlerOptions {
  info: ServerInfo;
  tools: readonly Tool[];
  /**
   * Told each tool call's name and outcome, and the client's self-description
   * when it sent one (the Claude Desktop extension does). Nothing else.
   */
  observe(tool: string, outcome: ToolOutcome, client: string | undefined): void;
}

export function mcpHandler(options: McpHandlerOptions): RequestHandler {
  return async (req, res) => {
    // The stateless form has no stream to open with GET and no session to end
    // with DELETE. Saying so is kinder than a protocol error.
    if (req.method !== "POST") {
      res
        .status(405)
        .set("Allow", "POST")
        .json({ jsonrpc: "2.0", error: { code: -32000, message: "This endpoint accepts POST only." }, id: null });
      return;
    }

    const { name, version, description, instructions } = options.info;
    const server = new McpServer({ name, version, description }, { instructions });
    const client = clientOf(req.get(CLIENT_HEADER));
    const host = observing(server, (tool, outcome) => options.observe(tool, outcome, client));
    for (const tool of options.tools) tool.register(host);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

/** A client's self-description, kept short and printable: it goes into the log. */
function clientOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const clean = header.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 80);
  return clean === "" ? undefined : clean;
}

/** The server as a host whose every registered handler reports to `observe` first. */
function observing(server: McpServer, observe: (tool: string, outcome: ToolOutcome) => void): ToolHost {
  const registerTool: McpServer["registerTool"] = (name, config, cb) => {
    // The callback's own type depends on the tool's input schema; the wrapper
    // forwards whatever it is given unchanged, so it is typed loosely here and
    // handed back as what it wraps.
    const handler = cb as unknown as (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
    const watched = async (...args: unknown[]): Promise<CallToolResult> => {
      try {
        const result = await handler(...args);
        observe(name, result.isError === true ? "error" : "ok");
        return result;
      } catch (error) {
        observe(name, "threw");
        throw error;
      }
    };
    return server.registerTool(name, config, watched as unknown as typeof cb);
  };
  return { registerTool };
}
