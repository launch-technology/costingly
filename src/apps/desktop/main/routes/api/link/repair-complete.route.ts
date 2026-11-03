/**
 * POST /api/link/repair-complete — the link page says a reconnect finished,
 * and the app marks the bank as working again. Open, like the page that
 * calls it.
 */

import type { LinkRouteDependencies } from "../../link.adapter.js";
import type { Route } from "../../route.js";

export function repairCompleteRoute(deps: LinkRouteDependencies): Route {
  return { path: "/api/link/repair-complete", method: "POST", access: "open", handler: deps.handlers.repairComplete };
}
