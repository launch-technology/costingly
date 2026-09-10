/**
 * Rendering the check for a model.
 *
 * Deliberately says nothing about the DATA — no row counts, no date ranges, no
 * last-sync time, and no bank list. This reports on costingly; what is in the
 * database is a question for `query`, and answering it here would make this the
 * tool called for everything.
 *
 * The profile line stays because it is identity, not data: costingly supports
 * several profiles, and answering a financial question against the wrong one is
 * the worst failure this can help prevent.
 *
 * The verdict comes FIRST and in one word, because it is the only line a model
 * has to read to decide what to do next.
 */

import type { Blocker, CostinglyStatus } from "../../../domain/services/status.service.js";

export function formatCheck(status: CostinglyStatus, blockers: Blocker[]): string {
    const lines: string[] = [];
    const { cluster, connection, migrationsApplied } = status.database;

    lines.push(blockers.length === 0 ? "costingly: READY" : "costingly: NOT READY");
    lines.push("");

    // --- the three artifacts -------------------------------------------------
    lines.push(
        `Profile:  ${status.profile.path}  (chosen by ${status.profile.chosenBy})` +
            (status.profile.exists ? "" : "  — not created yet"),
    );

    lines.push(`Database: ${cluster.path}  [${cluster.state}]`);
    if (cluster.error !== undefined) {
        lines.push(`          could not read server state: ${cluster.error}`);
    }
    if (connection.ok) {
        lines.push(`          connected in ${connection.elapsedMs}ms, listening on ${cluster.listenAddress}`);
    } else if (cluster.state !== "uninitialised") {
        lines.push(`          CANNOT CONNECT — ${connection.error ?? "unknown error"}`);
    }

    if (cluster.uptimeSeconds !== null) {
        lines.push(`          up ${formatDuration(cluster.uptimeSeconds)} (since ${cluster.startedAt})`);
        // Said out loud rather than left for the reader to infer from a small
        // number: a server that has only just started did not survive whatever
        // came before, and that is a different problem from a slow query.
        if (cluster.uptimeSeconds < 60) {
            lines.push(
                "          the server started only moments ago — if this keeps happening, " +
                    "two copies of costingly may be competing for it",
            );
        }
    }
    if (migrationsApplied !== null) {
        lines.push(`          schema: ${migrationsApplied.join(", ") || "none applied"}`);
    }

    lines.push(
        `Plaid:    ${status.plaid.environment} — ` +
            (status.plaid.reachable
                ? "reachable"
                : status.plaid.configured
                  ? `NOT REACHABLE: ${status.plaid.error ?? "no response"}`
                  : "no credentials"),
    );

    // --- what is blocking it -------------------------------------------------
    //
    // Facts only. Which tool fixes which is the model's decision from the tool
    // list it already has, and naming one here would go stale faster than the
    // state does.
    if (blockers.length > 0) {
        lines.push("");
        lines.push("Blocking, most fundamental first:");
        for (const blocker of blockers) {
            lines.push(`  - ${blocker.what}: ${blocker.detail}`);
        }
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
