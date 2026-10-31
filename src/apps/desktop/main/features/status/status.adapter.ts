/**
 * The Status screen's wiring: the real domain, fitted to what the status
 * controller asks for. WIRING ONLY — the domain's own checks, handed over as
 * they are, bound to the app's one Plaid client. No Electron.
 */

import { plaid } from "../../../../../domain/data/default-plaid.js";
import { checkPlaid, checkProfile } from "../../../../../domain/services/status.service.js";
import type { StatusChecks } from "./status.controller.js";

export function statusChecks(): StatusChecks {
  return { profile: checkProfile, plaid: () => checkPlaid(plaid) };
}
