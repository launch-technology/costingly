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

import type { BankToUnlink, UnlinkOutcome } from "../../../../../domain/services/banks/unlink.service.js";
import type { DatastoreState } from "../../../../../platform/datastore/datastore.js";
import { log } from "../../../../../platform/runtime/log.js";

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
    let result: UnlinkAttempt;
    try {
      if ((await this.deps.state()) !== "running") {
        result = { outcome: "database-stopped" };
      } else {
        const attempt = await this.deps.exclusively(() => this.deps.unlink(bankId, options));
        result = attempt.ran ? attempt.value : { outcome: "busy" };
      }
    } catch (error) {
      result = { outcome: "failed", reason: this.deps.describeError(error) };
    }
    this.record(result);
    return result;
  }

  private record(result: UnlinkAttempt): void {
    switch (result.outcome) {
      case "unlinked": {
        const bank = result.institutionName ?? "a bank";
        log.info(`unlinked ${bank}${result.revokedAtPlaid ? " and ended its connection at Plaid" : "; its connection at Plaid was kept"}`);
        return;
      }
      case "plaid-failed":
        log.warn(`unlink of ${result.institutionName ?? "a bank"} stopped: Plaid did not end the connection, nothing was deleted: ${result.reason}`);
        return;
      case "not-found":
        log.warn("unlink: no bank with that id");
        return;
      case "busy":
        log.info("unlink refused: a sync is running");
        return;
      case "database-stopped":
        log.warn("unlink refused: the database is not running");
        return;
      case "failed":
        log.error(`unlink failed: ${result.reason}`);
        return;
    }
  }
}
