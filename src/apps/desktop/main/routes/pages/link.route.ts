/**
 * GET /pages/link — the bank-link page, where Plaid's login runs in the
 * user's browser. `?repair=<id>` opens it in reconnect mode for one bank; the
 * page reads that itself.
 *
 * Open: a browser cannot present the token. What stands between the page and
 * the world is the web server's own rule that only this machine may reach it.
 */

import type { LinkRouteDependencies } from "../link.adapter.js";
import type { Route } from "../route.js";

export function linkPageRoute(deps: LinkRouteDependencies): Route {
  return { path: "/pages/link", method: "GET", access: "open", handler: deps.page };
}
