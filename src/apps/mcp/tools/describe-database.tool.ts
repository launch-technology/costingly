/**
 * describe_database — the schema, read out of the database itself.
 *
 * Generic on purpose: it renders whatever views and COMMENT ON entries exist,
 * so it describes costingly's ledger here and would describe anything else
 * elsewhere. The wording below talks about financial data because that is what
 * this app holds; an app with different data supplies its own description.
 *
 * The rendered document is cached for the life of the process. It is static
 * between migrations, which is exactly why dictionary.ts refuses to fold in
 * row counts or date ranges.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../../../domain/data/default-database.js";
import { describeDatabase, type DatabaseDoc } from "../../../domain/data/repositories/schema.repository.js";
import { renderDatabaseDoc } from "./describe-database.utils.js";

let cached: string | undefined;

async function getSchema(): Promise<string> {
    if (!cached) {
        const doc: DatabaseDoc = await describeDatabase(db);
        cached = renderDatabaseDoc(doc);
    }
    return cached;
}

export function registerDescribeDatabaseTool(server: McpServer): void {
    server.registerTool(
        'describe_database',
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
        async () => ({ content: [{ type: "text", text: await getSchema() }] }),
    )

}
