/**
 * POST /api/link/repair-token — the link page asks for a Plaid Link token in
 * update mode, to reconnect a bank whose login expired. Open, like the page
 * that calls it.
 */

import type { LinkRouteDependencies } from "../../link.adapter.js";
import type { Route } from "../../route.js";

export function repairTokenRoute(deps: LinkRouteDependencies): Route {
  return { path: "/api/link/repair-token", method: "POST", access: "open", handler: deps.handlers.repairToken };
}
