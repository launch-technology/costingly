/**
 * Removing costingly from this machine.
 *
 * Two things happen, in an order that is the whole point:
 *
 *   1. Revoke every Item at Plaid, so nothing is left billing.
 *   2. Delete the profile — config, cluster, log.
 *
 * Reversing them would be unrecoverable. Step 2 destroys the access tokens and
 * the key that decrypts them, and Plaid offers no way to look either up again:
 * an Item whose token is gone can never be reached, only paid for. So revoking
 * is attempted while the credentials still exist, or not at all.
 *
 * BEST EFFORT, NEVER BLOCKING
 *
 * A revoke failure does not stop the removal. The commonest reason to uninstall
 * is that something is already broken — a cluster that will not start, an
 * expired secret, no network — and letting any of those wedge the teardown
 * would leave the user with no way out at all. Failures come back in the result
 * for the caller to report; they are never thrown.
 *
 * Deleting the directory is the platform's job and knows nothing about Plaid.
 * The order above is costingly's knowledge, which is why the composition lives
 * here rather than a layer down.
 */

import { closeDb } from "../data/default-database.js";
import { removeProfile, type ProfileRemoval } from "../../platform/profile.js";
import { platform, server } from "../project.js";
import { describeError } from "../data/plaid.client.js";
import { removeAllItems } from "./banks/reset.service.js";
import type { RemovalOutcome } from "./banks/unlink.service.js";

export interface UninstallOptions {
  /**
   * Call Plaid's /item/remove for each bank before deleting.
   *
   * False is `--local-only`: nothing leaves the machine, and every Item stays
   * alive at Plaid — permanently unreachable once this finishes, because the
   * tokens go with the profile.
   */
  revoke: boolean;
}

export interface UninstallResult {
  /** One per bank, when revocation ran at all. */
  outcomes: RemovalOutcome[];

  /**
   * Why revocation produced no outcomes, or undefined if it ran.
   *
   * Distinguishes "not asked for" from "asked for and could not be done",
   * because only the second is a warning worth printing.
   */
  revokeError?: string;

  /** What the platform removed. */
  profile: ProfileRemoval;
}

/**
 * Revoke every Item, tolerating every way that can fail.
 *
 * `removeAllItems` already reports a per-item revoke failure without throwing.
 * What it cannot survive is the database being unreachable — which is exactly
 * the state a broken install is in — so the whole step is wrapped as well.
 */
async function revokeAll(): Promise<{ outcomes: RemovalOutcome[]; error?: string }> {
  try {
    return { outcomes: await removeAllItems({ revoke: true }) };
  } catch (error) {
    return { outcomes: [], error: describeError(error) };
  }
}

/**
 * Uninstall: revoke if asked, then delete the profile.
 *
 * Throws only if the profile itself could not be removed — a guard rejecting
 * the target, or a directory that will not delete. Everything else is reported.
 */
export async function uninstall(options: UninstallOptions): Promise<UninstallResult> {
  const revoked = options.revoke ? await revokeAll() : { outcomes: [] };

  // This process's own pool, released before the directory under it disappears.
  // `server.stop()` would disconnect us anyway, but a pool that is still open
  // when its cluster goes would spend the next thirty seconds reconnecting to
  // a socket that no longer exists.
  await closeDb();

  const profile = await removeProfile(platform, server);

  return revoked.error === undefined
    ? { outcomes: revoked.outcomes, profile }
    : { outcomes: revoked.outcomes, revokeError: revoked.error, profile };
}
