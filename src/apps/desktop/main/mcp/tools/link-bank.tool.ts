/**
 * link_bank — start connecting a new bank through Plaid Link.
 *
 * The one tool that cannot finish its own job: Plaid's login runs in a real
 * browser, on the page the app serves. So this hands back the page's address
 * and says what will happen there — and, since a link completes in the browser
 * long after this returned, a repeat call is the moment to report what was
 * connected in between.
 */

import type { LinkedItem } from "../../../../../domain/services/banks/link.service.js";
import type { DatastoreState } from "../../../../../platform/datastore/datastore.js";
import { MISSING_KEYS, PAGE_UNAVAILABLE, linkInstructions } from "../presenters/link.presenter.js";
import { databaseUnavailable } from "../presenters/query-result.presenter.js";
import type { Tool, ToolHost } from "./tool.js";

export interface LinkBankDependencies {
  /** Are both Plaid keys in place? */
  keysPresent(): boolean;
  /** Whether the database server is up. Reads a pid file; never starts anything. */
  state(): Promise<DatastoreState>;
  /** The link page's address on the app's own server, or undefined while that server is down. */
  pageAddress(): string | undefined;
  /** Banks connected in the browser since this was last asked. */
  takeRecentLinks(): LinkedItem[];
}

export class LinkBankTool implements Tool {
  readonly name = "link_bank";

  constructor(private readonly deps: LinkBankDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Connect a Bank",
        description:
          "Start connecting a bank or credit card. Returns a page address the user " +
          "must open in their browser — give it to them and ask them to say when they " +
          "have finished.\n\n" +
          "This cannot be completed for them. Plaid's login screen only runs in a real " +
          "browser, and for most large banks it sends the user to their bank's own " +
          "website to authenticate. Their credentials are typed into Plaid's window " +
          "and never reach costingly or this conversation.\n\n" +
          "Call this when no banks are connected or when the user asks to add one. " +
          "They can connect several in one visit. The page is served by the Costingly " +
          "app on their own machine, for as long as the app runs.\n\n" +
          "This connects a NEW bank. To repair an existing connection whose status " +
          "has gone to login_required, use relink_bank — using this one would create " +
          "a second, duplicate connection to the same bank and lose nothing but cost " +
          "everything.\n\n" +
          "When the user says they are done, call sync — that is what pulls their " +
          "transaction history in, and it is also how you find out which banks were " +
          "actually connected. The first sync after linking backfills up to two years " +
          "and takes noticeably longer than later ones.",
        annotations: {
          // Completing the flow in the browser writes an item and its accounts.
          readOnlyHint: false,
          // Only ever adds a bank. Nothing existing is touched.
          destructiveHint: false,
          // Calling twice returns the same address.
          idempotentHint: true,
          // Plaid, the user's bank, and a browser.
          openWorldHint: true,
        },
      },
      async () => {
        // Keys first. Without them Plaid rejects the page's first request with
        // an error that says nothing about what the user must do.
        if (!this.deps.keysPresent()) {
          return { content: [{ type: "text", text: MISSING_KEYS }], isError: true };
        }
        const database = await this.deps.state();
        if (database !== "running") {
          return { content: [{ type: "text", text: databaseUnavailable(database) }], isError: true };
        }
        const address = this.deps.pageAddress();
        if (address === undefined) {
          return { content: [{ type: "text", text: PAGE_UNAVAILABLE }], isError: true };
        }
        return { content: [{ type: "text", text: linkInstructions(address, this.deps.takeRecentLinks()) }] };
      },
    );
  }
}
