/**
 * The copied report, worded for a person pasting it into an issue.
 *
 * The same facts the check tool renders for a model and the status command
 * for a terminal, rendered a third way: plain text, facts first, the logs last.
 * Pure functions over the assembled report (report.service.ts, beside this), so
 * every line is a table entry in tests/desktop-report-presenter.test.mts.
 *
 * WHAT IT WILL NOT SAY. No account names, numbers or balances; no transactions;
 * no key, password or token. Banks are named — knowing WHICH bank failed to
 * sync is what makes a sync problem explainable — with their account count,
 * when they last synced and whether they need attention, and nothing beneath
 * that. The config values come through the status check's own display field,
 * which reports secrets as present or absent.
 */

import type { ItemAccountListing } from "../../../../../domain/data/repositories/items.repository.js";
import type { LogExcerpt, Problem } from "../../../bridge/contract.js";
import { explainDatabaseFailure } from "../database/database.presenter.js";
import type { Part, Report } from "./report.service.js";

export function presentReport(report: Report): string {
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push("", `== ${title} ==`);
  };

  lines.push(`Costingly ${report.version} — report made ${when(report.generatedAt)}`);

  section("Profile");
  lines.push(...orUnavailable(report.profile, "profile", presentProfile));

  section("Database");
  lines.push(...orUnavailable(report.database, "database", presentDatabase));

  section("Plaid");
  lines.push(
    ...orUnavailable(report.plaid, "Plaid", (plaid) => [
      plaid.configured ? "Keys: present" : "Keys: none entered",
      plaid.reachable ? "Plaid: answered" : plaid.configured ? `Plaid: did not answer — ${plaid.error ?? "no response"}` : "Plaid: not asked",
    ]),
  );

  section("Linked banks");
  lines.push(...orUnavailable(report.banks, "banks", presentBanks));

  section(`App log (last ${describeCount(report.appLog)})`);
  lines.push(...presentLog(report.appLog, "The app"));

  section(`Database log (last ${describeCount(report.databaseLog)})`);
  lines.push(...presentLog(report.databaseLog, "The database"));

  return `${lines.join("\n")}\n`;
}

/** A copy that did not happen, worded for the screen. */
export function copyFailed(what: string, reason: string): Problem {
  return {
    cause: `${what} could not be copied: ${reason}`,
    nextStep: "Try again. If it keeps happening, the lines are still on this screen to select and copy by hand.",
  };
}

// ---------------------------------------------------------------------------

function orUnavailable<T>(part: Part<T>, what: string, present: (value: T) => string[]): string[] {
  return part.ok ? present(part.value) : [`The ${what} could not be read: ${part.reason}`];
}

function presentProfile(profile: Report["profile"] extends Part<infer T> ? T : never): string[] {
  const lines = [`Location: ${profile.path} (chosen by ${profile.chosenBy})`];
  if (!profile.exists) {
    lines.push("Not created yet.");
    return lines;
  }
  lines.push(`Created: ${profile.createdAt ?? "unknown"}`);
  lines.push(
    profile.config.exists
      ? `Settings file: present${profile.config.mode === null ? "" : `, permissions ${profile.config.mode.toString(8)}`}`
      : "Settings file: none",
  );
  lines.push(`Database folder: ${profile.clusterExists ? "present" : "none"}`);
  for (const value of profile.values) lines.push(`${value.key}: ${value.display} (${value.source})`);
  return lines;
}

function presentDatabase(database: Report["database"] extends Part<infer T> ? T : never): string[] {
  if (!database.checked) {
    // The same explanation the Status screen shows for this failure.
    const { headline, problem } = explainDatabaseFailure(database.failure);
    return [`State: stopped`, `Last start: ${headline}. ${problem.cause}`];
  }

  const { cluster, connection, migrationsApplied } = database.health;
  const lines = [`State: ${cluster.state}`, `Location: ${cluster.path}`];
  if (cluster.error !== undefined) lines.push(`Could not read the server state: ${cluster.error}`);
  if (connection.ok) {
    lines.push(`Connection: answered in ${connection.elapsedMs ?? "?"} ms on ${cluster.listenAddress}`);
  } else if (cluster.state !== "uninitialised") {
    lines.push(`Connection: FAILED — ${connection.error ?? "unknown error"}`);
  }
  if (cluster.startedAt !== null) {
    lines.push(`Up since: ${cluster.startedAt}${cluster.uptimeSeconds === null ? "" : ` (${duration(cluster.uptimeSeconds)})`}`);
  }
  if (migrationsApplied !== null) lines.push(`Schema: ${migrationsApplied.join(", ") || "nothing applied"}`);
  return lines;
}

/** One line per bank; the accounts beneath are counted, never named. */
function presentBanks(rows: ItemAccountListing[]): string[] {
  const banks = new Map<string, { name: string; accounts: number; lastSynced: string; attention: boolean; sample: boolean }>();
  for (const row of rows) {
    const bank = banks.get(row.item_id) ?? {
      name: row.institution_name ?? "Unnamed bank",
      accounts: 0,
      lastSynced: row.last_synced_at === null ? "never" : when(new Date(row.last_synced_at)),
      attention: row.source === "plaid" && row.status === "login_required",
      sample: row.source !== "plaid",
    };
    if (row.account_id !== null) bank.accounts++;
    banks.set(row.item_id, bank);
  }
  if (banks.size === 0) return ["No banks are linked."];
  return [...banks.values()].map(
    (bank) =>
      `${bank.name}: ${bank.accounts} account${bank.accounts === 1 ? "" : "s"}, last synced ${bank.lastSynced}` +
      (bank.attention ? ", NEEDS ATTENTION (login expired)" : "") +
      (bank.sample ? " (sample data)" : ""),
  );
}

function presentLog(excerpt: LogExcerpt, who: string): string[] {
  switch (excerpt.state) {
    case "lines":
      return [`From ${excerpt.path}:`, ...excerpt.lines];
    case "empty":
      return [`${who} has not written a log yet. It will be at ${excerpt.path}`];
    case "unreadable":
      return [`${who} log could not be read. It should be at ${excerpt.path}`];
  }
}

function describeCount(excerpt: LogExcerpt): string {
  return excerpt.state === "lines" ? `${excerpt.lines.length} line${excerpt.lines.length === 1 ? "" : "s"}` : "0 lines";
}

function when(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`;
}
