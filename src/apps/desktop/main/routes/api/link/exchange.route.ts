/**
 * POST /api/link/exchange — the link page hands back a completed login, and
 * the app trades it for a permanent bank connection and saves it. Open, like
 * the page that calls it.
 */

import type { LinkRouteDependencies } from "../../link.adapter.js";
import type { Route } from "../../route.js";

export function exchangeRoute(deps: LinkRouteDependencies): Route {
  return { path: "/api/link/exchange", method: "POST", access: "open", handler: deps.handlers.exchange };
}
