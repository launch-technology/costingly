/**
 * What the tools need from costingly's domain, filled with the real thing.
 *
 * The only file under mcp/ that imports domain code (enforced by
 * tests/architecture.test.mts). The tools are written against the small
 * interfaces beside them and are handed these in the composition root, which
 * adds the app's own services — the sync, the unlink, the database — where a
 * tool must go through the app rather than around it.
 *
 * WIRING ONLY. The domain's own functions are handed over as they are, bound
 * to the app's one Plaid client and one database where they need one.
 */

import { adminDataSource, db } from "../../../../domain/data/default-database.js";
import { plaid } from "../../../../domain/data/default-plaid.js";
import { listBasic } from "../../../../domain/data/repositories/items.repository.js";
import { describeDatabase } from "../../../../domain/data/repositories/schema.repository.js";
import { server } from "../../../../domain/project.js";
import { takeRecentLinks, takeRecentRepairs } from "../../../../domain/services/banks/link-session.service.js";
import { queryReadOnly } from "../../../../domain/services/query/readonly-query.service.js";
import { blockersIn, costinglyStatus } from "../../../../domain/services/status.service.js";
import type { CheckCostinglyDependencies } from "./tools/check-costingly.tool.js";
import type { DescribeDatabaseDependencies } from "./tools/describe-database.tool.js";
import type { QueryDependencies } from "./tools/query.tool.js";

/** Whether the database server is up. Reads a pid file; never starts anything. */
export const datastoreState = () => server.status();

export function checkCostinglyDependencies(): CheckCostinglyDependencies {
  return {
    check: async () => {
      const status = await costinglyStatus(plaid);
      return { status, blockers: blockersIn(status) };
    },
  };
}

export function describeDatabaseDependencies(): DescribeDatabaseDependencies {
  return {
    state: datastoreState,
    describe: () => describeDatabase(db),
  };
}

export function queryDependencies(): QueryDependencies {
  return {
    state: datastoreState,
    query: queryReadOnly,
  };
}

/**
 * Every bank by id, name and status, without decrypting anything — through
 * the superuser connection, like the Accounts screen's own listing, so no
 * pool is left open behind a tool call.
 */
export const listBanks = () => listBasic(adminDataSource());

/** What finished in the browser since last asked: the link page records it, the tools report it. */
export const recentLinks = { takeRecentLinks, takeRecentRepairs };
