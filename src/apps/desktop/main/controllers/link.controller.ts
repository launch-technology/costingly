/**
 * Linking a bank, and reconnecting one: both open the link page in the user's
 * browser.
 *
 * NOT IN AN APP WINDOW, AND THAT IS A DECISION. It was built that way first.
 * Some banks worked; American Express did not — its login is screened by a
 * fraud-detection service that refuses anything but a real browser, and the
 * bank's page shows nothing when that happens, so the user sat at a spinning
 * button. Announcing the window as Chrome changed nothing. An app should not
 * be trying to get past a bank's screening, and one way of linking that works
 * for every bank beats two where one fails silently for some.
 *
 * So there is nothing to decide here. The page — the same one, served by the
 * same local server, that the CLI and the MCP server link through — creates
 * the token, runs Plaid's form, and stores the bank or repairs it. The app
 * starts it and opens the browser on it.
 */

import type { Controller, HandlersFor } from "./controller.js";

export class LinkController implements Controller<"link"> {
  constructor(
    /** Starts costingly's local link page and opens it in the default browser. */
    private readonly openLinkPageInBrowser: () => Promise<void>,
    /**
     * The same, in the page's reconnect mode for one bank. Rejects if the id
     * is not a linked bank's: the window names a bank, never an address.
     */
    private readonly openReconnectPageInBrowser: (bankId: string) => Promise<void>,
  ) {}

  handlers(): HandlersFor<"link"> {
    return {
      "link.openInBrowser": () => this.openLinkPageInBrowser(),

      "link.reconnectInBrowser": (bankId) => {
        // The types say a string, but this is a process boundary.
        if (typeof bankId !== "string" || bankId === "") {
          return Promise.reject(new Error("No bank was named."));
        }
        return this.openReconnectPageInBrowser(bankId);
      },
    };
  }
}
