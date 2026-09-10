/**
 * setup_costingly — create the local database.
 *
 * The bundle format has no install hook. The MCPB manifest supports no
 * `install`, `postinstall` or lifecycle field of any kind, and there is no
 * specified place for an extension's data or any cleanup when one is removed —
 * so the only actor that can set costingly up is costingly itself, when asked.
 *
 * Which makes this tool the install step, reachable the only way a bundle user
 * has: by asking.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { install } from "../../../domain/services/install.service.js";

export function registerSetupCostinglyTool(server: McpServer): void {
    server.registerTool(
        'setup_costingly',
        {
            title: "Set Up Costingly",
            description:
                "Create costingly's local database on this machine. Call this when " +
                "check_costingly reports that costingly is not set up.\n\n" +
                "It installs a PostgreSQL database in the user's own profile directory " +
                "and applies the schema. Takes a few seconds the first time. Safe to call " +
                "again — on a working install it checks and changes nothing.\n\n" +
                "IT DOES NOT CONFIGURE PLAID. Connecting a bank needs a Plaid client ID " +
                "and secret, which only the user can supply through Claude Desktop's " +
                "extension settings. So a successful setup routinely leaves those still " +
                "missing, and that is not a failure — run check_costingly afterwards to " +
                "see what remains.\n\n" +
                "Do not call this speculatively. It writes a database to the user's disk; " +
                "if a tool failed for some other reason, check_costingly says so.",
            inputSchema: {},
            annotations: {
                // Creates a database on the user's machine. Not destructive — it
                // never removes anything — but emphatically not read-only.
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            try {
                await install();
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                "Costingly's database is set up.\n\n" +
                                "If anything still behaves as though costingly is not installed, " +
                                "have the user fully quit Claude Desktop and reopen it — costingly " +
                                "reads its configuration once at startup.\n\n" +
                                "Run check_costingly to see whether anything else is still needed. " +
                                "Plaid credentials, in particular, are not set up by this tool.",
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `Setup failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
                                `Nothing was left half-created that a second attempt cannot finish — ` +
                                `this is safe to retry once. If it fails the same way twice, report ` +
                                `the error above rather than retrying further.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    )
}
