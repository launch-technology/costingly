/**
 * Every URL the app serves, in one table.
 *
 *   POST /mcp                        the model's endpoint          token
 *   GET  /pages/link                 the bank-link page            open
 *   POST /api/link/token             the page asks for a Plaid     open
 *                                    Link token
 *   POST /api/link/exchange          the page hands back a         open
 *                                    completed login
 *   POST /api/link/repair-token      the same, for reconnecting    open
 *                                    a bank whose login expired
 *   POST /api/link/repair-complete   the page says the reconnect   open
 *                                    finished
 *
 * Anything else is 404. The web server (shell/local-http-server.ts) is handed
 * this list by the composition root and enforces the access column; the page
 * and its calls are open because a browser cannot present the token.
 *
 * Each line is a file whose path spells the URL — see route.ts.
 */

import type { McpHandlerOptions } from "../mcp/mcp-handler.js";
import { exchangeRoute } from "./api/link/exchange.route.js";
import { repairCompleteRoute } from "./api/link/repair-complete.route.js";
import { repairTokenRoute } from "./api/link/repair-token.route.js";
import { tokenRoute } from "./api/link/token.route.js";
import type { LinkRouteDependencies } from "./link.adapter.js";
import { mcpRoute } from "./mcp.route.js";
import { linkPageRoute } from "./pages/link.route.js";
import type { Route } from "./route.js";

export interface RouteDependencies {
  mcp: McpHandlerOptions;
  link: LinkRouteDependencies;
}

export function routes(deps: RouteDependencies): Route[] {
  return [
    mcpRoute(deps.mcp),
    linkPageRoute(deps.link),
    tokenRoute(deps.link),
    exchangeRoute(deps.link),
    repairTokenRoute(deps.link),
    repairCompleteRoute(deps.link),
  ];
}
