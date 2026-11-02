/**
 * query — model-written SQL, run under the domain's guards.
 *
 * The tool itself is thin by design. Every protection lives in the read-only
 * query service it is handed: a read-only transaction, a role that reaches
 * only the v_ views, a statement timeout and a row cap. Nothing here inspects
 * the SQL, and nothing here should ever start.
 *
 * THE DATABASE IS ASKED WHETHER IT IS UP BEFORE IT IS ASKED ANYTHING ELSE. A
 * stopped database is explained, never contacted and never started.
 */

import { z } from "zod";

import type { ReadOnlyResult } from "../../../../../domain/services/query/readonly-query.service.js";
import type { DatastoreState } from "../../../../../platform/datastore/datastore.js";
import { databaseUnavailable, explainDatabaseError, formatRows } from "../presenters/query-result.presenter.js";
import type { Tool, ToolHost } from "./tool.js";

export interface QueryDependencies {
  /** Whether the database server is up. Reads a pid file; never starts anything. */
  state(): Promise<DatastoreState>;
  /** Run one SELECT under the read-only guards. Throws what the database refused. */
  query(sql: string): Promise<ReadOnlyResult>;
}

export class QueryTool implements Tool {
  readonly name = "query";

  constructor(private readonly deps: QueryDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Query Your Financial Transactions",
        description:
          "Run a read-only SQL SELECT against this user's bank and credit-card " +
          "transactions and get the rows back.\n\n" +
          "Call describe_database first to learn the views and columns. Guessing a " +
          "column name wastes a round trip; guessing a *value* is worse, because a " +
          "filter that matches nothing returns zero rows rather than an error.\n\n" +
          "PostgreSQL dialect. Enforced by the database, not by inspecting your SQL: " +
          "the transaction is read only, it runs as a role that can reach only the v_ " +
          "views, there is a statement timeout, and results are capped — so writes, " +
          "DDL, and any attempt to read encrypted credentials fail rather than being " +
          "silently ignored. Errors come back with PostgreSQL's own DETAIL and HINT; " +
          "read them and correct the query.\n\n" +
          "Prefer aggregating in SQL over returning many rows: SUM and GROUP BY answer " +
          "the question in a few lines, where a thousand raw transactions do not.",
        inputSchema: {
          sql: z
            .string()
            .min(1)
            .describe(
              "A single PostgreSQL SELECT statement. May use CTEs, joins, " +
                "aggregates and window functions. A trailing semicolon is fine. " +
                "Multiple statements are rejected. Remember that a POSITIVE amount " +
                "is money leaving the account.",
            ),
        },
        // Every hint stated rather than defaulted. destructiveHint and
        // idempotentHint are only meaningful when readOnlyHint is false, so
        // they are strictly redundant here — but a reader should not have to
        // know that rule to know what this tool does.
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ sql }) => {
        const state = await this.deps.state();
        if (state !== "running") {
          return { content: [{ type: "text", text: databaseUnavailable(state) }], isError: true };
        }
        try {
          return { content: [{ type: "text", text: formatRows(await this.deps.query(sql)) }] };
        } catch (error) {
          // Deliberately a result rather than a throw, so the model reads the
          // failure and fixes its own SQL.
          return { content: [{ type: "text", text: explainDatabaseError(error) }], isError: true };
        }
      },
    );
  }
}
