/**
 * restart_database — stop the local server and bring it back.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restartDatabase } from "../../../data/db/health.js";

/**
 * Stop the database and bring it back.
 *
 * Deliberately a restart rather than a stop. Stopping is never the goal —
 * it is a step towards connecting again, and costingly starts the server on
 * the next connection anyway. A stop tool would leave the model to guess
 * what to do next; this completes the round trip and reports whether the
 * database actually came back.
 */
export function registerRestartDatabaseTool(server: McpServer): void {
    server.registerTool(
        'restart_database',
        {
            title: "Restart the Costingly Database",
            description:
                "Stop costingly's local PostgreSQL server and start it again, then confirm " +
                "it is reachable. This clears most connection failures — a server left in " +
                "a bad state, a stale connection after the machine slept, or two copies of " +
                "costingly having competed for the same database.\n\n" +
                "Use it when check_database reports the database is not working, or when " +
                "tools keep failing with connection errors. If check_database says the " +
                "database is fine, this will not help — the problem is elsewhere.\n\n" +
                "No data is lost: the database is on disk and is not touched. A sync that " +
                "happens to be running is interrupted, and resumes where it left off the " +
                "next time it runs. Takes a few seconds.",
            inputSchema: {},
            annotations: {
                // Stops and starts a server process.
                readOnlyHint: false,
                // Nothing stored is altered or deleted. The only casualty is an
                // in-flight sync, which resumes from its cursor.
                destructiveHint: false,
                // Restarting twice leaves the same state as restarting once.
                idempotentHint: true,
                // Local process only.
                openWorldHint: false,
            },
        },
        async () => {
            const outcome = await restartDatabase();

            const what = outcome.wasRunning
                ? "Stopped the database server and started it again"
                : "The database server was not running; started it";

            if (outcome.ok) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `${what}. It is responding — took ${outcome.elapsedMs}ms.\n\n` +
                                `Retry whatever failed before.`,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `${what}, but it is still not responding after ` +
                            `${outcome.elapsedMs}ms.\n\n` +
                            `${outcome.error ?? "No further detail."}\n\n` +
                            `Call check_database for where the profile and cluster are. If ` +
                            `two copies of costingly are installed — an extension and a ` +
                            `manually configured server — they may be competing for the ` +
                            `same database, and one should be disabled.`,
                    },
                ],
                isError: true,
            };
        },
    )
}
