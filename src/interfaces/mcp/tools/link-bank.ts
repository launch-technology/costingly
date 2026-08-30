/**
 * link_bank — start connecting a new bank through Plaid Link.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startLinkServer, takeRecentLinks } from "../../web/server.js";
import { describeError } from "../../../data/plaid.client.js";
import { explainDbError } from "../../../data/db/errors.js";
import { credentialsPresent, MISSING_CREDENTIALS } from "../credentials.js";

export function registerLinkBankTool(server: McpServer): void {
    server.registerTool(
        'link_bank',
        {
            title: "Connect a Bank",
            description:
                "Start connecting a bank or credit card. Returns a URL the user must open " +
                "in their browser — give it to them and ask them to say when they have " +
                "finished.\n\n" +
                "This cannot be completed for them. Plaid's login screen only runs in a real " +
                "browser, and for most large banks it sends the user to their bank's own " +
                "website to authenticate. Their credentials are typed into Plaid's window " +
                "and never reach costingly or this conversation.\n\n" +
                "Call this when no banks are connected or when the user asks to add one. " +
                "They can connect several in one visit.\n\n" +
                "This connects a NEW bank. To repair an existing connection whose status " +
                "has gone to login_required, use relink_bank — using this one would create " +
                "a second, duplicate connection to the same bank and lose nothing but cost " +
                "everything.\n\n" +
                "When the user says they are done, call sync — that is what pulls their " +
                "transaction history in, and it is also how you find out which banks were " +
                "actually connected. The first sync after linking backfills up to two years " +
                "and takes noticeably longer than later ones.",
            annotations: {
                // The tool starts a local web server; completing the flow in the
                // browser writes an item and its accounts.
                readOnlyHint: false,
                // Only ever adds a bank. Nothing existing is touched.
                destructiveHint: false,
                // Calling twice returns the same URL for the same server.
                idempotentHint: true,
                // Plaid, the user's bank, and a browser.
                openWorldHint: true,
            },
        },
        async () => {
            // Credentials first. Without them Plaid rejects the token request
            // with an error that says nothing about what the user must do, and
            // in a bundled install there is no terminal to fix it from.
            if (!credentialsPresent()) {
                return {
                    content: [{ type: "text", text: MISSING_CREDENTIALS }],
                    isError: true,
                };
            }

            try {
                const { url } = await startLinkServer();
                const linked = takeRecentLinks();

                // A link completes in the browser long after this tool returned,
                // so a repeat call is the natural moment to report what happened
                // in between.
                const already =
                    linked.length === 0
                        ? ""
                        : `Since we last spoke, these were connected:\n` +
                          linked
                              .map(
                                  (i) =>
                                      `  ${i.institutionName ?? "(unknown bank)"} — ` +
                                      `${i.accountCount} account(s)`,
                              )
                              .join("\n") +
                          `\n\nCall sync to pull their transactions.\n\n`;

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                already +
                                `Ask the user to open this page in their browser:\n\n  ${url}\n\n` +
                                `They can connect as many banks as they like from it. The page is ` +
                                `served from their own machine and is not reachable from the ` +
                                `network; it shuts down by itself after ten minutes of inactivity.\n\n` +
                                `When they say they are finished, call sync.`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Could not start the link page: ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    )
}
