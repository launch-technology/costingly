/**
 * The status checks, as three IPC handlers.
 *
 * Three rather than one: the domain's `costinglyStatus()` runs all three checks
 * and returns when the slowest is done, and the slowest is Plaid — a network
 * round trip allowed eight seconds. A window should not blank its profile and
 * database sections for eight seconds because the network is slow, so each
 * section asks for its own check and fills in when its own answer arrives.
 *
 * REPORT-ONLY, like the checks underneath. Nothing here creates a profile,
 * starts a server or applies a schema; see the comments on `checkDatabase()`
 * for why a status report that provisions is worse than none.
 */

import { ipcMain } from "electron";

import { checkDatabase } from "../../domain/services/database/database-health.service.js";
import { checkPlaid, checkProfile } from "../../domain/services/status.service.js";
import { couldNotCheck, databaseView, plaidView, profileView } from "./status-view.js";
import type { SectionId, SectionView } from "./status-view.types.js";

const CHECKS: Record<SectionId, () => Promise<SectionView>> = {
  profile: async () => profileView(await checkProfile()),
  database: async () => databaseView(await checkDatabase()),
  plaid: async () => plaidView(await checkPlaid()),
};

/** The channel the renderer invokes for a section. */
export function statusChannel(section: SectionId): string {
  return `status:${section}`;
}

export function registerStatusHandlers(): void {
  for (const [section, check] of Object.entries(CHECKS) as Array<
    [SectionId, () => Promise<SectionView>]
  >) {
    ipcMain.handle(statusChannel(section), async (): Promise<SectionView> => {
      // The checks promise not to throw. If one does anyway, the answer is a
      // section that says so — a rejected invoke would surface in the renderer
      // as an exception, and one broken section must not take down the screen.
      try {
        return await check();
      } catch (error) {
        return couldNotCheck(error);
      }
    });
  }
}
