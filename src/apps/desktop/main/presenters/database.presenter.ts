/**
 * The database, worded for a person looking at a window: how it is, what is
 * wrong if anything, and which buttons to offer.
 *
 * ONE SOURCE FOR EVERY EXPLANATION. The status screen's Database section and
 * setup's database step both show what `explainDatabaseFailure` returns, so a
 * port conflict reads the same wherever it is met.
 *
 * Every explanation has a cause and a next step, and the next step is always
 * something the user can do in the app or to their machine — never a command
 * to run. The buttons are decided here too, so the window does not have to
 * work out which action fits which state: a failure offers the one action that
 * addresses it.
 *
 * THE LIVE CHECK WINS. The service remembers the last failure, but the
 * database can be started behind the app's back — the terminal command still
 * exists — and a remembered "would not start" beside a database that is
 * plainly running would be wrong. A remembered start failure is shown only
 * while the database is in fact down.
 *
 * Pure functions over plain objects: every state is a table entry in
 * tests/desktop-database-presenter.test.mts.
 */

import type { DatabaseHealth } from "../../../../domain/services/database/database-health.service.js";
import type { DatabaseAction, DatabaseSectionView, Problem } from "../../bridge/contract.js";
import type { DatabaseFailure } from "../services/database.service.js";
import { couldNotCheck } from "./status.presenter.js";

export interface FailureExplanation {
  headline: string;
  problem: Problem;
}

export function explainDatabaseFailure(failure: DatabaseFailure): FailureExplanation {
  switch (failure.kind) {
    case "port-in-use":
      return {
        headline: "Port in use",
        problem: {
          cause:
            failure.port === undefined
              ? "Another program is using the port the database needs."
              : `Another program is using port ${failure.port}, which the database needs.`,
          nextStep:
            "Close that program, then press Start. If you cannot find it, restarting your " +
            "computer will free the port.",
        },
      };

    case "will-not-start":
      return {
        headline: "Could not start",
        problem: {
          cause: `The database did not start. ${oneLine(failure.reason)}`,
          nextStep: "Press Start to try again. If it keeps failing, the details below show what the database reported.",
        },
      };

    case "not-answering":
      return {
        headline: "Running but not answering",
        problem: {
          cause: `The database is running but did not answer. ${oneLine(failure.reason)}`,
          nextStep: "Press Restart.",
        },
      };

    case "update-failed":
      return {
        headline: "Could not be updated",
        problem: {
          cause: `The database's tables could not be brought up to date. ${oneLine(failure.reason)}`,
          nextStep: "Press Retry. The data already in the database is not affected by a failed update.",
        },
      };

    case "create-failed":
      return {
        headline: "Could not be created",
        problem: {
          cause: `The database could not be created. ${oneLine(failure.reason)}`,
          nextStep: "Try again. If it keeps failing, the details below show what the database reported.",
        },
      };
  }
}

/**
 * The Database section for a database that is down because it would not start.
 *
 * Needs no health check, and that is the point of having it separately: the
 * health check tries to log in to whatever is on the database's port, and when
 * that is somebody else's program it can wait a long time for an answer that
 * is never coming. The failure is already known; the section can say so at once.
 */
export function presentStartFailure(
  failure: Extract<DatabaseFailure, { kind: "will-not-start" | "port-in-use" }>,
): DatabaseSectionView {
  return failed(failure, ["start"]);
}

/** The status screen's Database section. */
export function presentDatabaseSection(
  health: DatabaseHealth,
  failure: DatabaseFailure | undefined,
): DatabaseSectionView {
  const { cluster, connection, migrationsApplied } = health;

  if (cluster.error !== undefined || cluster.state === "unknown") {
    return {
      ...couldNotCheck(cluster.error ?? "The database server's state could not be read."),
      actions: [],
    };
  }

  // --- no database ----------------------------------------------------------
  if (cluster.state === "uninitialised") {
    if (failure?.kind === "create-failed") return failed(failure, ["create"]);
    return {
      tone: "neutral",
      headline: "Not created",
      details: [],
      problem: { cause: "No database has been created yet.", nextStep: "Press Create database." },
      actions: ["create"],
    };
  }

  // --- down -----------------------------------------------------------------
  if (cluster.state === "stopped") {
    if (failure?.kind === "will-not-start" || failure?.kind === "port-in-use") {
      return presentStartFailure(failure);
    }
    return {
      tone: "warn",
      headline: "Stopped",
      details: ["The database exists but its server is not running."],
      actions: ["start"],
    };
  }

  if (cluster.state !== "running") {
    return { ...couldNotCheck(`Unexpected server state "${cluster.state}".`), actions: [] };
  }

  // --- up, but not usable ---------------------------------------------------
  if (!connection.ok) {
    return failed(
      { kind: "not-answering", reason: connection.error ?? "It did not answer a query." },
      ["restart"],
    );
  }

  // --- up -------------------------------------------------------------------
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

  if (failure?.kind === "update-failed") {
    const { headline, problem } = explainDatabaseFailure(failure);
    return { tone: "bad", headline, details, problem, actions: ["update"] };
  }

  return { tone: "good", headline: "Running", details, actions: ["stop", "restart"] };
}

function failed(failure: DatabaseFailure, actions: DatabaseAction[]): DatabaseSectionView {
  const { headline, problem } = explainDatabaseFailure(failure);
  return { tone: "bad", headline, details: [], problem, actions };
}

/**
 * A reason from underneath, made fit for one sentence.
 *
 * Those messages are written for a terminal: several lines, and a closing
 * pointer to the log file. The window has "Show details" for the log, so that
 * pointer is dropped and the rest is joined up.
 */
function oneLine(reason: string): string {
  const lines = reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const pointer = lines.findIndex((line) => /log may say more/i.test(line));
  const kept = pointer === -1 ? lines : lines.slice(0, pointer);

  const text = kept.join(" ");
  return text === "" || /[.!?]$/.test(text) ? text : `${text}.`;
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
