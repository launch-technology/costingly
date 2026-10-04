/**
 * First-run setup's calls: what is set up, check-and-save the keys, create
 * the database, and open Plaid's keys page.
 *
 * THE LINKS TAKE NO ADDRESS. The window cannot navigate or open anything (see
 * shell/main-window.ts), and these are the only exceptions: two constants,
 * opened in the user's own browser. The page can ask for "Plaid's site" or
 * "the Plaid keys page" and nothing else, so no string that reaches the window
 * — a Plaid error message, say — can turn into somewhere the app will go.
 */

import type { SetupService } from "../services/setup.service.js";
import type { Controller, HandlersFor } from "./controller.js";

const PLAID_SITE_URL = "https://plaid.com";
const PLAID_KEYS_URL = "https://dashboard.plaid.com/developers/keys";

export class SetupController implements Controller<"setup"> {
  constructor(
    private readonly setup: SetupService,
    /** Opens an address in the user's default browser. Electron's, in the app. */
    private readonly openInBrowser: (url: string) => Promise<void>,
  ) {}

  handlers(): HandlersFor<"setup"> {
    return {
      "setup.state": () => this.setup.state(),

      "setup.submitKeys": (clientId, secret) => {
        // The types say strings, but this is a process boundary: what arrives
        // is whatever the page sent.
        if (typeof clientId !== "string" || typeof secret !== "string") {
          return Promise.resolve({
            outcome: "rejected" as const,
            reason: "Both the client ID and the secret are required.",
          });
        }
        return this.setup.submitKeys(clientId, secret);
      },

      "setup.createDatabase": () => this.setup.createDatabase(),

      "setup.openPlaidSite": () => this.openInBrowser(PLAID_SITE_URL),
      "setup.openPlaidKeysPage": () => this.openInBrowser(PLAID_KEYS_URL),
    };
  }
}
