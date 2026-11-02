/**
 * describe_database — the schema, read out of the database itself.
 *
 * Generic on purpose: it renders whatever views and COMMENT ON entries exist,
 * so it describes costingly's ledger here and would describe anything else
 * elsewhere. The wording talks about financial data because that is what this
 * app holds.
 *
 * THE DATABASE IS ASKED WHETHER IT IS UP BEFORE IT IS ASKED ANYTHING ELSE. A
 * stopped database is explained, never contacted and never started; that is
 * the app's rule for every reader, and a tool is a reader.
 *
 * The rendered document is cached on the tool for as long as the tool lives,
 * which is as long as the app runs. It is static between migrations, which is
 * exactly why the renderer refuses to fold in row counts or date ranges.
 */

import type { DatabaseDoc } from "../../../../../domain/data/repositories/schema.repository.js";
import type { DatastoreState } from "../../../../../platform/datastore/datastore.js";
import { renderDatabaseDoc } from "../presenters/database-description.presenter.js";
import { databaseUnavailable, explainDatabaseError } from "../presenters/query-result.presenter.js";
import type { Tool, ToolHost } from "./tool.js";

export interface DescribeDatabaseDependencies {
  /** Whether the database server is up. Reads a pid file; never starts anything. */
  state(): Promise<DatastoreState>;
  /** The views and their columns, read from the database. */
  describe(): Promise<DatabaseDoc>;
}

export class DescribeDatabaseTool implements Tool {
  readonly name = "describe_database";
  private cached: string | undefined;

  constructor(private readonly deps: DescribeDatabaseDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Describe Costingly Database",
        description:
          "What you need to write a correct SQL query against costingly's financial " +
          "data: the queryable views, and every column with its type and what it " +
          "actually means.\n\n" +
          "Call this before writing any SQL. Several conventions here cannot be guessed " +
          "— positive amounts mean money OUT, and a pending row is later replaced by a " +
          "settled row with a different id, so counting both double-counts.\n\n" +
          "Returns structure only. It does not say which values are present, how many " +
          "rows exist, or what dates are covered, because those change on every sync. " +
          "Enumerate those with SQL before filtering on a literal: a filter on a " +
          "category or account this database does not contain returns zero rows rather " +
          "than an error, which is indistinguishable from a real answer.",
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
      async () => {
        const state = await this.deps.state();
        if (state !== "running") {
          return { content: [{ type: "text", text: databaseUnavailable(state) }], isError: true };
        }
        try {
          // Only a successful read is kept: a failure is explained and asked again next time.
          this.cached ??= renderDatabaseDoc(await this.deps.describe());
          return { content: [{ type: "text", text: this.cached }] };
        } catch (error) {
          return { content: [{ type: "text", text: explainDatabaseError(error) }], isError: true };
        }
      },
    );
  }
}
