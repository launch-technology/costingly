/**
 * The Accounts screen's wiring: the real domain, fitted to what the accounts
 * and unlink services ask for, and the local link page that "Link a bank"
 * opens. WIRING ONLY — the domain's listing, unlink and link server, handed
 * over as they are, bound to the app's one Plaid client. No Electron.
 */

import { adminDataSource } from "../../../../../domain/data/default-database.js";
import { plaid } from "../../../../../domain/data/default-plaid.js";
import { listWithAccounts } from "../../../../../domain/data/repositories/items.repository.js";
import { server } from "../../../../../domain/project.js";
import { startLinkServer, stopLinkServer } from "../../../../../domain/services/banks/link-session.service.js";
import { describeBank, unlinkBank } from "../../../../../domain/services/banks/unlink.service.js";
import { describeError } from "../../shared/domain.adapter.js";
import type { AccountsDependencies } from "./accounts.service.js";
import type { UnlinkDependencies } from "./unlink.service.js";

/**
 * What the Accounts screen is read from.
 *
 * Through the superuser connection, like the status report's own bank list:
 * it holds no pool open between reads, so looking at a screen leaves nothing
 * behind for a later Stop to wait on.
 */
export function accountsDependencies(): AccountsDependencies {
  return {
    state: () => server.status(),
    list: () => listWithAccounts(adminDataSource()),
    describeError,
  };
}

/**
 * costingly's local link page: the one the CLI and the MCP server already
 * link banks through, served on this machine only, and shut down by itself
 * when idle. Linking from the app means starting it and opening the user's
 * browser on it; the app stops it on Quit.
 */
export const linkPage = {
  start: () => startLinkServer(plaid),
  stop: stopLinkServer,

  /**
   * The page's address in reconnect mode for one bank — after checking that
   * the id is a real, linked bank's. The id arrives from the window; an
   * address is built only here, from the server's own and an id the database
   * already holds.
   */
  async startForReconnect(bankId: string): Promise<string> {
    const banks = await listWithAccounts(adminDataSource());
    if (!banks.some((bank) => bank.item_id === bankId && bank.source === "plaid")) {
      throw new Error("That bank is not one of your linked banks.");
    }
    const { url } = await startLinkServer(plaid);
    return `${url}/?repair=${encodeURIComponent(bankId)}`;
  },
};

/**
 * Unlinking a bank: the domain's one operation for it, bound to the app's
 * Plaid client. The app adds only who may run it and when.
 */
export function unlinkDependencies(): Pick<UnlinkDependencies, "state" | "describe" | "unlink" | "describeError"> {
  return {
    state: () => server.status(),
    describe: describeBank,
    unlink: (bankId, options) => unlinkBank(plaid, bankId, options),
    describeError,
  };
}
