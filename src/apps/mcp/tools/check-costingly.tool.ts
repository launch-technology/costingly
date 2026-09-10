/**
 * check_costingly — is costingly usable, and if not, what is stopping it?
 *
 * Replaced `check_database`, which reported only the database. That name told a
 * model to reach for it when a query failed and NOT when the real problem was a
 * missing Plaid key or a profile that had never been created — so the tool that
 * existed to answer "why isn't this working" could not answer it.
 *
 * Registered because a bundled install has no terminal. Everything here is also
 * `costingly status`, rendered for a different reader.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { blockersIn, costinglyStatus } from "../../../domain/services/status.service.js";
import { formatCheck } from "./check-costingly.utils.js";

export function registerCheckCostinglyTool(server: McpServer): void {
    server.registerTool(
        'check_costingly',
        {
            title: "Check Costingly",
            description:
                "Whether costingly is set up and working, and what is stopping it if not. " +
                "Reports three things: the profile directory in use, the local database " +
                "(created? running? reachable? which migrations?), and Plaid (are " +
                "credentials present, and does the API answer).\n\n" +
                "Call this when any other costingly tool fails, or when the user says " +
                "costingly is broken, not working, or not set up. It is built to answer " +
                "when everything else is down — that is the case it exists for.\n\n" +
                "It distinguishes states that need different responses. NOT SET UP means " +
                "nothing has been created and setup_costingly will fix it. NOT RUNNING " +
                "means the database exists but its server is down, which restart_database " +
                "fixes. NO PLAID CREDENTIALS is the one YOU CANNOT FIX: no tool supplies " +
                "them, so tell the user to enter both keys in Claude Desktop's extension " +
                "settings and then FULLY QUIT and reopen the app — costingly reads them at " +
                "startup, so a running copy can never see keys entered after it launched. " +
                "Retrying will not help and will produce this same answer.\n\n" +
                "It reports on costingly, not on the user's money. It returns no " +
                "transactions, balances or totals: for those use query, and for the views " +
                "and columns needed to write one use describe_database.\n\n" +
                "The profile line is worth reading even when everything works. Costingly " +
                "supports several profiles and only one is active, so it is also the " +
                "answer to \"why is costingly showing me different data than I expect\".",
            inputSchema: {},
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                // Reads this machine's own files and database. The Plaid check is
                // one small API call, so this is not strictly closed-world.
                openWorldHint: true,
            },
        },
        async () => {
            // costinglyStatus() is documented never to throw; a try/catch here
            // anyway, because a health tool that fails is a contradiction and
            // the guarantee is worth belt and braces.
            try {
                const status = await costinglyStatus();
                return {
                    content: [{ type: "text", text: formatCheck(status, blockersIn(status)) }],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `The check itself failed: ${
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
