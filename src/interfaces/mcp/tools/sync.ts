/**
 * sync — pull the latest transactions from the user's banks.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { syncAllItems } from "../../../services/banks/sync.js";
import { explainDbError } from "../../../data/db/errors.js";
import { formatSyncSummary } from "../format.js";

export function registerSyncTool(server: McpServer): void {
    server.registerTool(
        'sync',
        {
            title: "Sync Transactions From Banks",
            description:
                "Pull the latest transactions and balances from the user's banks via Plaid " +
                "and store them locally. Everything else here reads a local snapshot; this " +
                "is the only tool that refreshes it.\n\n" +
                "Call it when the user asks to refresh, when they mention a purchase too " +
                "recent to be in the data, or at the start of a scheduled report so the " +
                "figures are current. Do not call it before every query — the data does not " +
                "change between questions.\n\n" +
                "Safe to re-run: changes are keyed on transaction id, so a second run in a " +
                "row does nothing. Usually a few seconds. The very first run for a newly " +
                "linked bank backfills up to two years and takes considerably longer.\n\n" +
                "Banks sync independently and some can fail while others succeed — most " +
                "often because a bank connection expired and needs re-authentication. When " +
                "that happens the result says so at the top, and any figures you report " +
                "afterwards are incomplete. Pass that on to the user rather than presenting " +
                "partial data as a full picture.",
            // Every hint stated. The defaults are readOnlyHint false,
            // destructiveHint TRUE, idempotentHint false, openWorldHint TRUE —
            // so silence here would advertise a destructive, non-idempotent
            // tool and invite clients to gate it far harder than it deserves.
            annotations: {
                // Writes: upserts transactions, removes ones Plaid reports gone,
                // refreshes balances, advances each item's cursor.
                readOnlyHint: false,
                // Deletions are reconciliation with the source of truth, never of
                // anything the user created, and a later sync restores anything
                // removed in error.
                destructiveHint: false,
                // Cursor-based. Running twice in a row adds nothing — the property
                // that makes an unattended schedule safe.
                idempotentHint: true,
                // The only tool here that leaves the machine. Network latency,
                // third-party outages and the user's Plaid quota all apply.
                openWorldHint: true,
            },
        },
        async () => {
            try {
                const summary = await syncAllItems();
                return {
                    content: [{ type: "text", text: formatSyncSummary(summary) }],
                    // Partial failure is NOT an error result. A scheduled report that
                    // treats it as one would abandon the run and send nothing, when
                    // three of four banks did update. The warning at the top of the
                    // text is what carries it. Total failure is a different matter.
                    isError: summary.itemsTotal > 0 && summary.itemsSucceeded === 0,
                };
            } catch (error) {
                return {
                    content: [{ type: "text", text: explainDbError(error) }],
                    isError: true,
                };
            }
        },
    )
}
