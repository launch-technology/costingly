/**
 * relink_bank — repair a connection whose login expired.
 *
 * Like link_bank, it hands back an address: the same page, in reconnect mode
 * for one bank. The id is checked against the banks that exist before any
 * address is built, and an unknown id gets the list back instead.
 */

import { z } from "zod";

import type { ItemSummary } from "../../../../../domain/data/repositories/items.repository.js";
import type { RepairedItem } from "../../../../../domain/services/banks/link-session.service.js";
import type { DatastoreState } from "../../../../../platform/datastore/datastore.js";
import { MISSING_KEYS, PAGE_UNAVAILABLE, relinkInstructions, unknownBank } from "../presenters/link.presenter.js";
import { databaseUnavailable, explainDatabaseError } from "../presenters/query-result.presenter.js";
import type { Tool, ToolHost } from "./tool.js";

export interface RelinkBankDependencies {
  keysPresent(): boolean;
  /** Whether the database server is up. Reads a pid file; never starts anything. */
  state(): Promise<DatastoreState>;
  /**
   * Every bank, by id, name and status — listed without decrypting anything:
   * an item whose token no longer decrypts is exactly the kind that might
   * need repairing.
   */
  listBanks(): Promise<ItemSummary[]>;
  /** The page's reconnect address for one bank, or undefined while the app's server is down. */
  reconnectAddress(bankId: string): string | undefined;
  /** Connections repaired in the browser since this was last asked. */
  takeRecentRepairs(): RepairedItem[];
}

export class RelinkBankTool implements Tool {
  readonly name = "relink_bank";

  constructor(private readonly deps: RelinkBankDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Reconnect a Bank Whose Login Expired",
        description:
          "Repair a bank connection that has stopped working — usually because the " +
          "user changed their password, or the bank expired the authorisation. Returns " +
          "a page address for the user to open, where they sign in to that bank again.\n\n" +
          "Use this, NOT link_bank, whenever a bank already exists in v_items. It " +
          "repairs the existing connection in place: same accounts, transaction " +
          "history kept, nothing re-downloaded, no second connection billed. Removing " +
          "and re-adding the bank would lose the history and create a duplicate.\n\n" +
          "The signal that a bank needs this is v_items.status = 'login_required', " +
          "which sync sets when a bank stops answering. A sync that reports one bank " +
          "failing while others succeed is usually this.\n\n" +
          "Takes an item_id from v_items. After the user says they have signed in, " +
          "call sync to catch up on anything missed while the connection was down.",
        inputSchema: {
          item_id: z
            .string()
            .min(1)
            .describe("The Plaid item id of the bank to reconnect, exactly as it appears in v_items.item_id."),
        },
        annotations: {
          // Clears the item's login_required status once repaired.
          readOnlyHint: false,
          // Repairs; never removes anything.
          destructiveHint: false,
          // Calling twice just returns the same address.
          idempotentHint: true,
          // Plaid, the user's bank, and a browser.
          openWorldHint: true,
        },
      },
      async ({ item_id }) => {
        if (!this.deps.keysPresent()) {
          return { content: [{ type: "text", text: MISSING_KEYS }], isError: true };
        }
        const database = await this.deps.state();
        if (database !== "running") {
          return { content: [{ type: "text", text: databaseUnavailable(database) }], isError: true };
        }
        try {
          const banks = await this.deps.listBanks();
          const bank = banks.find((b) => b.itemId === item_id);
          if (bank === undefined) {
            return {
              content: [{ type: "text", text: unknownBank(item_id, banks, "No banks are connected. Use link_bank to add one.") }],
              isError: true,
            };
          }
          const address = this.deps.reconnectAddress(item_id);
          if (address === undefined) {
            return { content: [{ type: "text", text: PAGE_UNAVAILABLE }], isError: true };
          }
          const name = bank.institutionName ?? bank.itemId;
          return { content: [{ type: "text", text: relinkInstructions(address, name, this.deps.takeRecentRepairs()) }] };
        } catch (error) {
          return { content: [{ type: "text", text: explainDatabaseError(error) }], isError: true };
        }
      },
    );
  }
}
