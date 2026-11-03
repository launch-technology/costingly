/**
 * What a route is: one URL the app serves, declared in full.
 *
 * The HTTP counterpart of shared/controller.ts and mcp/tools/tool.ts. A
 * controller answers the window, a tool answers a model, and a route answers
 * a program on this machine that speaks HTTP. Each route file under routes/
 * declares one: its path, the method it takes, whether it needs the token,
 * and the handler, which is thin and calls a service.
 *
 * THE FILE IS THE URL. routes/api/link/token.route.ts declares /api/link/token,
 * routes/pages/link.route.ts declares /pages/link, routes/mcp.route.ts declares
 * /mcp; tests/architecture.test.mts checks that each file's path matches its
 * place. routes/index.ts lists them all, so there is one table to read and
 * nothing is registered by scanning a folder.
 *
 * The three prefixes are three kinds of thing, kept apart on purpose:
 *
 *   /mcp       the model's endpoint, behind the token
 *   /pages/*   pages a browser opens
 *   /api/*     the JSON calls those pages make
 */

import type { RequestHandler } from "express";

/** Whether a route needs the token, or is open to any program on this machine. */
export type RouteAccess = "token" | "open";

export interface Route {
  /** The path, exactly: "/mcp". */
  path: string;
  /** The one method the route answers; any other is refused with 405. Omitted, it answers any. */
  method?: "GET" | "POST";
  access: RouteAccess;
  handler: RequestHandler;
}
