/**
 * uninstall_costingly — remove everything costingly keeps on this machine.
 *
 * WHY THIS IS NOT A CONVENIENCE
 *
 * On Windows, Claude Desktop is a packaged (MSIX) app, so its filesystem writes
 * are virtualised: the profile it creates at `%LOCALAPPDATA%\costingly` really
 * lives under `…\Packages\<package>\LocalCache\Local\costingly`. A terminal
 * running the CLI is unpackaged, resolves the plain path, and therefore CANNOT
 * see — let alone delete — the extension's profile.
 *
 * This tool runs inside the packaged process, so it resolves the same paths the
 * extension actually uses. For a bundle install it is the only thing that can
 * clean up. Removing the extension takes the code and leaves the database, the
 * encryption key, the Plaid credentials and a detached postmaster behind.
 *
 * TWO-PHASE, like unlink_bank. The first call reports what would be lost and
 * mints a token; the second spends it. The point is not to stop the model — it
 * holds the token — but to force the numbers into the transcript where a human
 * can see them and say no, and to make a single injected "uninstall costingly"
 * return a preview instead of a deletion.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { platform } from "../../../domain/project.js";
import { countData } from "../../../domain/services/banks/reset.service.js";
import { uninstall } from "../../../domain/services/uninstall.service.js";
import { ConfirmationStore } from "../utils/confirmations.js";

/**
 * How long an uninstall confirmation stays spendable.
 *
 * Long enough for the model to put the numbers to the user and get an answer,
 * short enough that a token cannot sit waiting in a conversation that moved on.
 */
const UNINSTALL_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

const confirmations = new ConfirmationStore(UNINSTALL_CONFIRMATION_TTL_MS);

/** One subject, because there is only ever one profile to remove. */
const SUBJECT = "profile";

export function registerUninstallCostinglyTool(server: McpServer): void {
    server.registerTool(
        'uninstall_costingly',
        {
            title: "Uninstall Costingly",
            description:
                "Permanently delete everything costingly keeps on this machine: the local " +
                "database and every transaction in it, the encryption key, and the stored " +
                "Plaid credentials. By default it also removes each bank at Plaid, so " +
                "nothing is left billing there.\n\n" +
                "IRREVERSIBLE. There is no undo and no backup.\n\n" +
                "Two calls. The first reports exactly what would be destroyed and returns " +
                "a confirmation_token — nothing is deleted. Put those numbers to the user " +
                "in plain language and WAIT for them to agree. Only then call again with " +
                "the token. If they say no, or do not answer, let it expire.\n\n" +
                "Call this only when the user asks to uninstall, remove or delete " +
                "costingly. Never as a way to fix a problem — a broken database is what " +
                "check_costingly and restart_database are for, and this destroys the data " +
                "rather than repairing it.\n\n" +
                "It cannot remove the extension itself. Tell the user to do that in " +
                "Claude Desktop's settings afterwards.",
            inputSchema: {
                confirmation_token: z
                    .string()
                    .optional()
                    .describe(
                        "Omit on the first call to get a report and a token. Supply the " +
                            "token on the second call to actually delete. Single use, " +
                            "expires in five minutes.",
                    ),
                keep_plaid_items: z
                    .boolean()
                    .optional()
                    .describe(
                        "Leave the banks connected at Plaid instead of removing them. " +
                            "Defaults to false. Setting this true leaves Items alive and " +
                            "BILLING, and because their access tokens are deleted here they " +
                            "can never be used again — only paid for. Use it only if the " +
                            "user explicitly asks to keep them.",
                    ),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                // The second call is not idempotent in any useful sense: it spends
                // a token, and there is nothing left to repeat it against.
                idempotentHint: false,
                // Removing Items at Plaid is a call to a third party.
                openWorldHint: true,
            },
        },
        async ({ confirmation_token, keep_plaid_items }) => {
            const revoke = keep_plaid_items !== true;

            try {
                // ---- Phase one: report, mint a token, delete nothing ----------
                if (confirmation_token === undefined) {
                    // A broken database is a normal reason to be uninstalling, so
                    // failing to count must not stop the tool — it only means the
                    // report says less.
                    let stakes: string[];
                    try {
                        const counts = await countData();
                        stakes = [
                            `  ${counts.items} bank(s)`,
                            `  ${counts.accounts} account(s)`,
                            `  ${counts.transactions} transaction(s)`,
                        ];
                    } catch {
                        stakes = ["  contents unknown — the database could not be read"];
                    }

                    const token = confirmations.issue(SUBJECT);

                    return {
                        content: [
                            {
                                type: "text",
                                text: [
                                    "NOTHING HAS BEEN DELETED YET.",
                                    "",
                                    "Uninstalling costingly would permanently destroy:",
                                    ...stakes,
                                    "  the encryption key and the stored Plaid credentials",
                                    `  the profile directory: ${platform.displayPath(platform.profileDir())}`,
                                    "",
                                    revoke
                                        ? "Each bank would also be removed at Plaid, so nothing keeps billing."
                                        : "Banks would be LEFT at Plaid. They keep billing, and because their " +
                                          "access tokens are deleted here they can never be used again.",
                                    "",
                                    "Put this to the user and wait for them to agree. Then call",
                                    "uninstall_costingly again with:",
                                    "",
                                    `  confirmation_token: ${token}`,
                                    "",
                                    "The token works once and expires in five minutes. If the user says",
                                    "no, or does not answer, let it expire — there is nothing to undo.",
                                ].join("\n"),
                            },
                        ],
                    };
                }

                // ---- Phase two: spend the token, then destroy -----------------
                // Spent before anything is deleted, so a failure part-way through
                // cannot leave a token behind that would delete a second time.
                if (!confirmations.spend(confirmation_token, SUBJECT)) {
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    "That confirmation token is not valid or has expired, so " +
                                    "nothing was deleted. Call uninstall_costingly with no token " +
                                    "to get a fresh report, and confirm with the user again.",
                            },
                        ],
                        isError: true,
                    };
                }

                const result = await uninstall({ revoke });

                const lines: string[] = [];
                for (const outcome of result.outcomes) {
                    const name = outcome.institutionName ?? outcome.itemId;
                    lines.push(
                        outcome.revokeError !== undefined
                            ? `  ${name} — deleted locally, but REMOVING IT AT PLAID FAILED: ${outcome.revokeError}`
                            : outcome.revoked
                              ? `  ${name} — deleted, and removed at Plaid`
                              : `  ${name} — deleted locally`,
                    );
                }

                const stranded = result.outcomes.filter((o) => o.revokeError !== undefined);
                const warnings: string[] = [];

                if (result.revokeError !== undefined) {
                    warnings.push(
                        `The database could not be read, so no bank was removed at Plaid: ${result.revokeError}`,
                    );
                }
                if (stranded.length > 0 || !revoke) {
                    warnings.push(
                        "Tell the user that any bank still at Plaid keeps billing, and that " +
                            "its access token is now gone so it can never be used again. They " +
                            "can remove those at my.plaid.com or dashboard.plaid.com.",
                    );
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                result.profile.existed
                                    ? `Costingly has been uninstalled. Profile deleted: ${platform.displayPath(result.profile.profileDir)}`
                                    : `Nothing to delete — no profile at ${platform.displayPath(result.profile.profileDir)}`,
                                ...(lines.length > 0 ? ["", ...lines] : []),
                                ...(warnings.length > 0 ? ["", ...warnings] : []),
                                "",
                                "The extension itself is still installed. Tell the user to remove it " +
                                    "in Claude Desktop's settings if they want it gone.",
                                "",
                                "Every costingly tool will now report that nothing is set up, which " +
                                    "is correct. setup_costingly would build a new, empty database.",
                            ].join("\n"),
                        },
                    ],
                    ...(stranded.length > 0 || result.revokeError !== undefined
                        ? { isError: true }
                        : {}),
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `Uninstall failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
                                `Nothing may have been deleted, or only part of it. The most common ` +
                                `cause is that something is still using the database — if Claude ` +
                                `Desktop has another window open, or a terminal is connected, close ` +
                                `it and try again.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    )
}
