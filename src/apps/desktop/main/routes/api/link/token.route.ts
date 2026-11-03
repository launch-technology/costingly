/**
 * POST /api/link/token — the link page asks for a one-time Plaid Link token,
 * which lets it open Plaid's login. Open, like the page that calls it.
 */

import type { LinkRouteDependencies } from "../../link.adapter.js";
import type { Route } from "../../route.js";

export function tokenRoute(deps: LinkRouteDependencies): Route {
  return { path: "/api/link/token", method: "POST", access: "open", handler: deps.handlers.createToken };
}
