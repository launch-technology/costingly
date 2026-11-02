/**
 * What the tools need from costingly's domain, filled with the real thing.
 *
 * The only file under mcp/ that imports domain code (enforced by
 * tests/architecture.test.mts). The tools are written against the small
 * interfaces beside them and are handed these in the composition root.
 *
 * WIRING ONLY. The domain's own functions are handed over as they are, bound
 * to the app's one Plaid client and one database where they need one.
 */

import { db } from "../../../../domain/data/default-database.js";
import { plaid } from "../../../../domain/data/default-plaid.js";
import { describeDatabase } from "../../../../domain/data/repositories/schema.repository.js";
import { server } from "../../../../domain/project.js";
import { queryReadOnly } from "../../../../domain/services/query/readonly-query.service.js";
import { blockersIn, costinglyStatus } from "../../../../domain/services/status.service.js";
import type { CheckCostinglyDependencies } from "./tools/check-costingly.tool.js";
import type { DescribeDatabaseDependencies } from "./tools/describe-database.tool.js";
import type { QueryDependencies } from "./tools/query.tool.js";

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
    state: () => server.status(),
    describe: () => describeDatabase(db),
  };
}

export function queryDependencies(): QueryDependencies {
  return {
    state: () => server.status(),
    query: queryReadOnly,
  };
}
