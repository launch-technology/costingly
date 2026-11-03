/**
 * What the link page's routes need from the domain: the page itself, and the
 * four handlers behind its calls, bound to the app's one Plaid client.
 *
 * The handlers are the domain's own (services/banks/link-session.service.ts),
 * shared with the command line's on-demand server until that is retired; the
 * app adds nothing to them but a place to live. The only file under routes/
 * that imports domain code.
 */

import { plaid } from "../../../../domain/data/default-plaid.js";
import { linkHandlers, linkPageHandler, type LinkHandlers } from "../../../../domain/services/banks/link-session.service.js";
import type { RequestHandler } from "express";

export interface LinkRouteDependencies {
  /** Sends the page. */
  page: RequestHandler;
  handlers: LinkHandlers;
}

export function linkRouteDependencies(): LinkRouteDependencies {
  return { page: linkPageHandler(), handlers: linkHandlers(plaid) };
}
