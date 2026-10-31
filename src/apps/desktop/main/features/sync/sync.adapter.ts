/**
 * The sync's wiring: the real domain, fitted to what the sync service asks
 * for. WIRING ONLY — the domain's one sync, bound to the app's Plaid client.
 * No Electron.
 */

import { plaid } from "../../../../../domain/data/default-plaid.js";
import { syncAllItems } from "../../../../../domain/services/banks/sync.service.js";
import { describeError } from "../../shared/domain.adapter.js";
import type { SyncDependencies } from "./sync.service.js";

/** The sync, as the domain runs it for every interface. */
export function syncDependencies(): Pick<SyncDependencies, "run" | "describeError"> {
  return { run: () => syncAllItems(plaid), describeError };
}
