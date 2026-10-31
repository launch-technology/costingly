/**
 * The Logs screen's wiring: the real domain, fitted to what the report service
 * asks for. WIRING ONLY — the same checks the Status screen runs, the bank
 * listing and the two logs, handed over as they are. No Electron.
 */

import { adminDataSource } from "../../../../../domain/data/default-database.js";
import { plaid } from "../../../../../domain/data/default-plaid.js";
import { listWithAccounts } from "../../../../../domain/data/repositories/items.repository.js";
import { server } from "../../../../../domain/project.js";
import { checkDatabase } from "../../../../../domain/services/database/database-health.service.js";
import { checkPlaid, checkProfile } from "../../../../../domain/services/status.service.js";
import { packageVersion } from "../../../../../platform/package.js";
import { appLog, databaseLog, describeError } from "../../shared/domain.adapter.js";
import type { ReportDependencies } from "./report.service.js";

/**
 * What the copied report is made from: the same checks the Status screen's
 * sections run, the bank listing the Accounts screen is drawn from, and the two
 * logs. Each is gathered on its own, so one that fails costs only its part.
 */
export function reportDependencies(): Omit<ReportDependencies, "lastFailure"> {
  return {
    version: packageVersion,
    profile: checkProfile,
    plaid: () => checkPlaid(plaid),
    database: {
      health: checkDatabase,
      state: () => server.status(),
    },
    banks: () => listWithAccounts(adminDataSource()),
    appLog,
    databaseLog,
    describeError,
    now: () => new Date(),
  };
}
