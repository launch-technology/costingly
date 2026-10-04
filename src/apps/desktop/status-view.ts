/**
 * The status reports, worded for a person looking at a window.
 *
 * The domain's reports carry facts plus the odd terminal-flavoured hint
 * ("run `costingly init`"). Those hints are the CLI's wording, not ours — the
 * same fact reads differently in a window with a button than at a prompt — so
 * this reads the facts and says each state in its own words. Pure functions
 * over plain objects, which is what makes every state a table entry in
 * tests/desktop-status.test.mts rather than a database to build and break.
 *
 * Report-only. Nothing here suggests a fix, because this story offers none;
 * the stories that add setup and database controls will add the actions beside
 * the facts, not inside them.
 */

import type { DatabaseHealth } from "../../domain/services/database/database-health.service.js";
import type { PlaidStatus, ProfileStatus } from "../../domain/services/status.service.js";
import type { SectionView } from "./status-view.types.js";

export function profileView(profile: ProfileStatus): SectionView {
  const where = `Data folder: ${profile.path}`;
  // Only worth saying when something other than the default chose it — that is
  // the case where a person is looking at a profile they did not expect.
  const chosen =
    profile.chosenBy === "platform default" ? [] : [`Location chosen by ${profile.chosenBy}`];

  if (!profile.exists) {
    return {
      tone: "neutral",
      headline: "Not set up",
      details: ["No data folder has been created yet.", where, ...chosen],
    };
  }

  return {
    tone: "good",
    headline: "Set up",
    details: [
      where,
      ...chosen,
      profile.config.exists ? "Settings file present." : "No settings file yet.",
    ],
  };
}

export function databaseView(health: DatabaseHealth): SectionView {
  const { cluster, connection, migrationsApplied } = health;

  if (cluster.error !== undefined || cluster.state === "unknown") {
    return couldNotCheck(cluster.error ?? "The database server's state could not be read.");
  }

  switch (cluster.state) {
    case "uninitialised":
      return {
        tone: "neutral",
        headline: "Not created",
        details: ["No database has been created yet."],
      };
    case "stopped":
      return {
        tone: "warn",
        headline: "Stopped",
        details: ["The database exists but its server is not running."],
      };
    case "running":
      break;
    default:
      return couldNotCheck(`Unexpected server state "${cluster.state}".`);
  }

  if (!connection.ok) {
    return {
      tone: "bad",
      headline: "Running but not answering",
      details: [connection.error ?? "The server is up but did not answer a query."],
    };
  }

  const details = [`Listening on ${cluster.listenAddress}`];
  if (cluster.uptimeSeconds !== null) {
    details.push(
      `Up ${formatDuration(cluster.uptimeSeconds)}` +
        (cluster.startedAt === null ? "" : ` since ${cluster.startedAt}`),
    );
  }
  if (migrationsApplied !== null) {
    const latest = migrationsApplied[migrationsApplied.length - 1];
    details.push(latest === undefined ? "No tables created yet." : `Schema version: ${latest}`);
  } else if (connection.error !== undefined) {
    details.push(`Schema could not be read: ${connection.error}`);
  }

  return { tone: "good", headline: "Running", details };
}

export function plaidView(plaid: PlaidStatus): SectionView {
  if (!plaid.configured) {
    return {
      tone: "neutral",
      headline: "No keys entered",
      details: ["Plaid keys have not been entered yet."],
    };
  }

  if (plaid.reachable) {
    return {
      tone: "good",
      headline: "Keys present and working",
      details: [`Environment: ${plaid.environment}`],
    };
  }

  return {
    tone: "warn",
    headline: "Keys present but Plaid could not be reached",
    details: [plaid.error ?? "Plaid did not respond.", `Environment: ${plaid.environment}`],
  };
}

/**
 * A check that threw instead of reporting.
 *
 * The checks are written never to throw, so reaching this means something
 * outside their contract went wrong. It is still shown as a section outcome,
 * not an error dialog: one section failing must leave the other two readable.
 */
export function couldNotCheck(error: unknown): SectionView {
  return {
    tone: "bad",
    headline: "Could not check",
    details: [error instanceof Error ? error.message : String(error)],
  };
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
