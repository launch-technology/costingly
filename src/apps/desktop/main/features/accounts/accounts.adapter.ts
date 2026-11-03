/**
 * The Accounts screen's wiring: the real domain, fitted to what the accounts
 * and unlink services ask for, and the one check "Reconnect" makes before it
 * builds an address. WIRING ONLY — the domain's listing and unlink, handed
 * over as they are, bound to the app's one Plaid client. No Electron.
 */

import { adminDataSource } from "../../../../../domain/data/default-database.js";
import { plaid } from "../../../../../domain/data/default-plaid.js";
import { listWithAccounts } from "../../../../../domain/data/repositories/items.repository.js";
import { server } from "../../../../../domain/project.js";
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
 * Is this id a real, linked bank's? Asked before any reconnect address is
 * built: the id arrives from the window, and an address is built only from
 * an id the database already holds. The page itself is served by the app's
 * own web server (routes/pages/link.route.ts).
 */
export async function isLinkedBank(bankId: string): Promise<boolean> {
  const banks = await listWithAccounts(adminDataSource());
  return banks.some((bank) => bank.item_id === bankId && bank.source === "plaid");
}

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
