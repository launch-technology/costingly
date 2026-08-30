/**
 * check_database — is it working, and which profile is this?
 *
 * Registered because a bundled install has no terminal. Everything this
 * reports was previously only reachable through the CLI, which is fine for a
 * developer and useless for someone whose only interface is a chat window.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkDatabase } from "../../../data/db/health.js";
import { formatHealth } from "./check-database.utils.js";

/**
 * Is it working, and which profile is this?
 *
 * Registered because a bundled install has no terminal. Everything this
 * reports was previously only reachable through `costingly doctor` and
 * `costingly status`, which is fine for a developer and useless for someone
 * whose only interface is a chat window.
 */
export function registerCheckDatabaseTool(server: McpServer): void {
    server.registerTool(
        'check_database',
        {
            title: "Check the Costingly Database",
            description:
                "Whether costingly's database is working: which profile directory is in " +
                "use, whether the local PostgreSQL server is running, whether a query " +
                "round trip succeeds and how long it takes, how long the server has been " +
                "up, and which schema migrations are applied.\n\n" +
                "Call this when another costingly tool fails with a connection or " +
                "database error, or when the user says costingly is broken or not " +
                "responding. It is designed to work when the database is down — that is " +
                "the case it exists for — so it answers even when nothing else does.\n\n" +
                "It reports on the DATABASE, not on the data inside it. It returns no " +
                "transactions, balances, totals or dates: for anything about the user's " +
                "money use query, and for the views and columns needed to write one use " +
                "describe_database.\n\n" +
                "The profile line is worth reading even when everything works. Costingly " +
                "supports several profiles and only one is active, so it is also the " +
                "answer to \"why is costingly showing me different data than I expect\".",
            inputSchema: {},
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                // Reads only this machine's own files and database.
                openWorldHint: false,
            },
        },
        async () => {
            // checkDatabase() is documented never to throw; a try/catch here
            // anyway, because a health tool that fails is a contradiction and
            // the guarantee is worth belt and braces.
            try {
                return { content: [{ type: "text", text: formatHealth(await checkDatabase()) }] };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `The health check itself failed: ${
                                    error instanceof Error ? error.message : String(error)
                                }\n\n` +
                                `That should not be possible. Try restart_database.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    )
}
