/**
 * relink_bank — repair a connection whose login expired.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startLinkServer, takeRecentRepairs } from "../../web/server.js";
import { query } from "../../../data/db/queries.js";
import { describeError } from "../../../data/plaid.client.js";
import { explainDbError } from "../../../data/db/errors.js";
import { credentialsPresent, MISSING_CREDENTIALS } from "../credentials.js";

export function registerRelinkBankTool(server: McpServer): void {
    server.registerTool(
        'relink_bank',
        {
            title: "Reconnect a Bank Whose Login Expired",
            description:
                "Repair a bank connection that has stopped working — usually because the " +
                "user changed their password, or the bank expired the authorisation. Returns " +
                "a URL for the user to open, where they sign in to that bank again.\n\n" +
                "Use this, NOT link_bank, whenever a bank already exists in v_items. It " +
                "repairs the existing connection in place: same accounts, transaction " +
                "history kept, nothing re-downloaded, no second connection billed. Removing " +
                "and re-adding the bank would lose the history and create a duplicate.\n\n" +
                "The signal that a bank needs this is v_items.status = 'login_required', " +
                "which sync sets when a bank stops answering. A sync that reports one bank " +
                "failing while others succeed is usually this.\n\n" +
                "Takes an item_id from v_items. After the user says they have signed in, " +
                "call sync to catch up on anything missed while the connection was down.",
            inputSchema: {
                item_id: z
                    .string()
                    .min(1)
                    .describe(
                        "The Plaid item id of the bank to reconnect, exactly as it appears " +
                        "in v_items.item_id.",
                    ),
            },
            annotations: {
                // Clears the item's login_required status once repaired.
                readOnlyHint: false,
                // Repairs; never removes anything.
                destructiveHint: false,
                // Calling twice just re-opens the same page.
                idempotentHint: true,
                // Plaid, the user's bank, and a browser.
                openWorldHint: true,
            },
        },
        async ({ item_id }) => {
            if (!credentialsPresent()) {
                return { content: [{ type: "text", text: MISSING_CREDENTIALS }], isError: true };
            }

            try {
                // Listed without decrypting: naming a bank needs no credential,
                // and an item whose token no longer decrypts is exactly the kind
                // that might need repairing.
                const { rows: items } = await query<{
                    item_id: string;
                    institution_name: string | null;
                    status: string;
                }>(
                    `SELECT item_id, institution_name, status FROM items
                      ORDER BY institution_name NULLS LAST, created_at`,
                );
                const item = items.find((i) => i.item_id === item_id);

                if (item === undefined) {
                    const known =
                        items.length === 0
                            ? "No banks are connected. Use link_bank to add one."
                            : "Connected banks:\n" +
                              items
                                  .map(
                                      (i) =>
                                          `  ${i.item_id}  ${i.institution_name ?? "(unknown bank)"}` +
                                          `  [${i.status}]`,
                                  )
                                  .join("\n");
                    return {
                        content: [
                            { type: "text", text: `No bank has item_id "${item_id}".\n\n${known}` },
                        ],
                        isError: true,
                    };
                }

                const { url } = await startLinkServer();
                const name = item.institution_name ?? item.item_id;

                // A repair finishes in the browser long after this returned, so
                // a repeat call is the natural place to report it — same reason
                // link_bank reports completed links.
                const repaired = takeRecentRepairs();
                const already =
                    repaired.length === 0
                        ? ""
                        : "Since we last spoke, these connections were repaired:\n" +
                          repaired
                              .map((r) => `  ${r.institutionName ?? r.itemId}`)
                              .join("\n") +
                          "\n\nCall sync to catch up on what they missed.\n\n";

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                already +
                                `Ask the user to open this page and sign in to ${name} again:\n\n` +
                                `  ${url}/?repair=${encodeURIComponent(item_id)}\n\n` +
                                `This repairs the existing connection — their transaction ` +
                                `history is kept and nothing is re-downloaded. The page is ` +
                                `served from their own machine and shuts down by itself after ` +
                                `ten minutes of inactivity.\n\n` +
                                `When they say they have signed in, call sync to catch up on ` +
                                `anything missed while the connection was down.`,
                        },
                    ],
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
