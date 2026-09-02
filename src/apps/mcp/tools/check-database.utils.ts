/**
 * Rendering the health report for check_database.
 *
 * Deliberately says nothing about the DATA — no row counts, no date ranges, no
 * last-sync time. This reports on the database; what is in it is a question for
 * query, and answering it here would make check_database the tool called for
 * everything.
 *
 * The profile line stays because it is identity, not data: costingly supports
 * several profiles, and answering a financial question against the wrong one is
 * the worst failure this tool can help prevent.
 */

import type { DatabaseHealth } from "../../../domain/services/database/database-health.service.js";

export function formatHealth(health: DatabaseHealth): string {
    const lines: string[] = [];

    const verdict = health.connection.ok
        ? health.connection.error === undefined
            ? "WORKING"
            : "CONNECTED, but the schema could not be read"
        : "NOT WORKING";
    lines.push(`Database: ${verdict}`);
    lines.push("");

    lines.push(`Profile:  ${health.profile.path}  (chosen by ${health.profile.chosenBy})`);
    lines.push(`Cluster:  ${health.cluster.path}  [${health.cluster.state}]`);
    if (health.cluster.error !== undefined) {
        lines.push(`          could not read server state: ${health.cluster.error}`);
    }

    if (health.connection.ok) {
        lines.push(`Connect:  ok in ${health.connection.elapsedMs}ms`);
    } else {
        lines.push(`Connect:  FAILED after ${health.connection.elapsedMs ?? 0}ms`);
        lines.push(`          ${health.connection.error ?? "unknown error"}`);
    }

    if (health.cluster.uptimeSeconds !== null) {
        lines.push(
            `Uptime:   ${formatDuration(health.cluster.uptimeSeconds)}` +
                `  (since ${health.cluster.startedAt})`,
        );
        // Said out loud rather than left for the reader to infer from a small
        // number: a server that has only just started did not survive whatever
        // came before, and that is a different problem from a slow query.
        if (health.cluster.uptimeSeconds < 60) {
            lines.push(
                "          the server started only moments ago — if this keeps happening, " +
                    "two copies of costingly may be competing for it",
            );
        }
    }

    if (health.migrationsApplied !== null) {
        lines.push(`Schema:   ${health.migrationsApplied.join(", ") || "none applied"}`);
    } else if (health.connection.ok) {
        lines.push(`Schema:   could not be read — ${health.connection.error ?? "unknown error"}`);
    }

    if (!health.connection.ok) {
        lines.push("");
        lines.push(
            "If this profile should be working, restart_database stops the server and " +
                "brings it back, which clears most connection failures. If it still fails " +
                "afterwards, the error above is the one to report.",
        );
    }

    return lines.join("\n");
}

/** "45s", "3h 12m", "2d 5h" — enough precision to judge, no more. */
function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
