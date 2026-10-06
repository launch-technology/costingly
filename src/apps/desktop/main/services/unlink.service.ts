/**
 * Unlinking a bank from the Accounts screen.
 *
 * What unlinking IS — revoke at Plaid first, delete nothing if that fails —
 * is the domain's, one operation used by every interface, and is called here
 * as it is. This is what a window in a long-running app needs around it:
 *
 *   IS THE DATABASE UP? If not, that is the answer, and nothing is asked of it.
 *
 *   NEVER DURING A SYNC. A sync writes the rows an unlink deletes. The unlink
 *   takes exclusive use from the sync service for as long as it runs, and is
 *   told "busy" if a sync already has the floor.
 *
 *   NEVER THROW. Whatever goes wrong comes back as something to show.
 *
 * No Electron and no domain imports beyond types.
 */

import type { BankToUnlink, UnlinkOutcome } from "../../../../domain/services/banks/unlink.service.js";
import type { DatastoreState } from "../../../../platform/datastore/datastore.js";

export interface UnlinkDependencies {
  /** Whether the database server is up. Reads a pid file; never starts anything. */
  state(): Promise<DatastoreState>;
  /** A bank and what it holds, or null if there is no such bank. */
  describe(bankId: string): Promise<BankToUnlink | null>;
  /** The domain's unlink. */
  unlink(bankId: string, options: { revokeAtPlaid: boolean }): Promise<UnlinkOutcome>;
  /** Run work that must not overlap a sync. `ran: false` when a sync is running. */
  exclusively<T>(work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
}

/** Why a bank could not be looked at or unlinked, beyond what the domain itself reports. */
export type UnlinkBlocked =
  | { outcome: "database-stopped" }
  /** A sync is running. */
  | { outcome: "busy" }
  | { outcome: "failed"; reason: string };

export type UnlinkPreviewed = { outcome: "found"; bank: BankToUnlink } | { outcome: "not-found" } | UnlinkBlocked;
export type UnlinkAttempt = UnlinkOutcome | UnlinkBlocked;

export class UnlinkService {
  constructor(private readonly deps: UnlinkDependencies) {}

  /** What unlinking this bank would delete. Reads only. */
  async preview(bankId: string): Promise<UnlinkPreviewed> {
    try {
      if ((await this.deps.state()) !== "running") return { outcome: "database-stopped" };
      const bank = await this.deps.describe(bankId);
      return bank === null ? { outcome: "not-found" } : { outcome: "found", bank };
    } catch (error) {
      return { outcome: "failed", reason: this.deps.describeError(error) };
    }
  }

  async unlink(bankId: string, options: { revokeAtPlaid: boolean }): Promise<UnlinkAttempt> {
    try {
      if ((await this.deps.state()) !== "running") return { outcome: "database-stopped" };
      const attempt = await this.deps.exclusively(() => this.deps.unlink(bankId, options));
      return attempt.ran ? attempt.value : { outcome: "busy" };
    } catch (error) {
      return { outcome: "failed", reason: this.deps.describeError(error) };
    }
  }
}
