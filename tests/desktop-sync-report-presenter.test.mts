/**
 * The sync, worded for a model — a table.
 *
 * This is where the design lives: the output is read by a model that is about
 * to write a report, and a partial failure must be impossible to skim past.
 * Assertions below check ORDER, not just presence. Moved here from the old
 * server's suite when the sync tool moved into the app, with the new wording
 * for the sync's state beside it.
 */

import {
  NO_SYNC_YET,
  UNLINK_IN_PROGRESS,
  alreadyRunning,
  formatSyncStatus,
  formatSyncSummary,
  runFailed,
  stillRunning,
} from "../src/apps/desktop/main/mcp/presenters/sync-report.presenter.js";

type SyncSummary = import("../src/domain/services/banks/sync.types.js").SyncSummary;
type ItemSyncResult = import("../src/domain/services/banks/sync.types.js").ItemSyncResult;

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

const FORBIDDEN = /Claude Desktop|costingly\s+(init|migrate|sync|status|stop|link|unlink|uninstall|reset|seed|doctor)\b|`costingly/i;

const item = (over: Partial<ItemSyncResult>): ItemSyncResult =>
  ({
    itemId: "i",
    institutionName: "Bank",
    ok: true,
    added: 0,
    modified: 0,
    removed: 0,
    accounts: 1,
    pages: 1,
    initialBackfill: false,
    updateStatus: null,
    ...over,
  }) as ItemSyncResult;
const summary = (over: Partial<SyncSummary>): SyncSummary => ({
  ok: true,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:04.200Z",
  durationMs: 4200,
  itemsTotal: 1,
  itemsSucceeded: 1,
  itemsFailed: 0,
  added: 0,
  modified: 0,
  removed: 0,
  results: [],
  ...over,
});

// --- a clean run --------------------------------------------------------------
{
  const clean = formatSyncSummary(
    summary({
      itemsTotal: 2,
      itemsSucceeded: 2,
      added: 12,
      modified: 1,
      results: [item({ institutionName: "Ally", added: 12, modified: 1 }), item({ institutionName: "Amex" })],
    }),
  );
  ok(!/WARNING/.test(clean), "a clean sync carries no warning");
  ok(clean.includes("Ally: +12 added, ~1 updated"), "and reports each bank's changes");
  ok(clean.includes("Amex: no changes"), "including the ones with nothing new");
  ok(clean.includes("Totals: 12 added"), "plus totals");
}

// --- a partial failure --------------------------------------------------------
{
  const partial = formatSyncSummary(
    summary({
      itemsTotal: 2,
      itemsSucceeded: 1,
      itemsFailed: 1,
      ok: false,
      added: 12,
      results: [
        item({ institutionName: "Ally", added: 12 }),
        item({ institutionName: "Chase", ok: false, error: "ITEM_LOGIN_REQUIRED: the login is required" }),
      ],
    }),
  );
  ok(/INCOMPLETE/.test(partial), "a partial failure says the data is incomplete");
  ok(partial.includes("Chase: ITEM_LOGIN_REQUIRED"), "and names the bank and the reason");
  ok(/Say so explicitly/i.test(partial), "and instructs the reader to pass it on");
  ok(/relink_bank repairs it/.test(partial), "AN EXPIRED LOGIN NAMES THE TOOL THAT REPAIRS IT");
  // THE ASSERTION THAT MATTERS: the warning must come before any number, or a
  // model skimming for the result will report confidently on partial data.
  ok(partial.indexOf("INCOMPLETE") < partial.indexOf("Synced"), "THE WARNING PRECEDES EVERY FIGURE — it cannot be skimmed past");
  ok(partial.indexOf("INCOMPLETE") < partial.indexOf("Totals:"), "and precedes the totals");
}

// --- two states that look like success and are not ---------------------------
{
  const backfill = formatSyncSummary(summary({ added: 2814, results: [item({ added: 2814, initialBackfill: true })] }));
  ok(/full history backfill/.test(backfill), "a first sync is flagged as a backfill");
  const notReady = formatSyncSummary(summary({ results: [item({ added: 3, updateStatus: "NOT_READY" as never })] }));
  ok(/still preparing/.test(notReady), "NOT_READY is spelled out, so a small number does not read as 'nothing to do'");
  ok(/Sync again shortly/.test(notReady), "and says what to do about it");
}

// --- no banks ---------------------------------------------------------------------
{
  const none = formatSyncSummary(summary({ itemsTotal: 0, itemsSucceeded: 0 }));
  ok(/setup step, not an error/i.test(none), "no banks: this is setup, not failure");
  ok(/link_bank/.test(none) && /Link a bank/.test(none), "AND NAMES THE TOOL AND THE BUTTON, never a command");
}

// --- the sync's state, when there is no fresh run to report -------------------
{
  const now = new Date("2026-01-01T00:01:00.000Z");
  const started = new Date("2026-01-01T00:00:48.000Z");
  ok(/already running/.test(alreadyRunning(started, now)) && /12 seconds ago/.test(alreadyRunning(started, now)), "already running: says so, with how long ago it started");
  ok(/sync_status/.test(alreadyRunning(started, now)), "and names sync_status");
  ok(/has not finished yet/.test(stillRunning(started, now)) && /sync_status/.test(stillRunning(started, now)), "still running: says so and names sync_status");
  ok(/do not call sync again/.test(stillRunning(started, now)), "and says not to call sync again meanwhile");
  ok(/could not run: boom/.test(runFailed("boom")) && /check_costingly/.test(runFailed("boom")), "a run that failed carries the reason and points at check_costingly");
  ok(/being unlinked/.test(UNLINK_IN_PROGRESS), "a start refused during an unlink says why");
  ok(/No sync has run since Costingly started/.test(NO_SYNC_YET), "nothing yet: says so, and that it is not an error");

  eq(formatSyncStatus({ phase: "idle" }, now), NO_SYNC_YET, "sync_status, idle: nothing yet");
  const running = formatSyncStatus({ phase: "running", trigger: "mcp", startedAt: started }, now);
  ok(/running/.test(running) && /12 seconds ago/.test(running) && /through this endpoint/.test(running), "sync_status, running: since when and who started it");
  const fromApp = formatSyncStatus({ phase: "running", trigger: "manual", startedAt: started }, now);
  ok(/started from the app/.test(fromApp), "a sync the button started is said to be");
  const failed = formatSyncStatus({ phase: "failed", trigger: "mcp", reason: "no network" }, now);
  ok(/could not run/.test(failed) && /no network/.test(failed), "sync_status, failed: the reason");
  const finished = formatSyncStatus({ phase: "finished", trigger: "manual", summary: summary({ results: [item({ institutionName: "Ally", added: 2 })], added: 2 }) }, now);
  ok(/started 2026-01-01T00:00:00.000Z and finished 2026-01-01T00:00:04.200Z/.test(finished), "sync_status, finished: the run's times");
  ok(/Ally: \+2 added/.test(finished), "and the run's report");
}

// --- none of it points away from the app -----------------------------------------
{
  const everything = [
    formatSyncSummary(summary({ itemsTotal: 0 })),
    formatSyncSummary(summary({ results: [item({ ok: false, error: "ITEM_LOGIN_REQUIRED" })], itemsFailed: 1, itemsSucceeded: 0 })),
    alreadyRunning(new Date(0), new Date(0)),
    stillRunning(new Date(0), new Date(0)),
    runFailed("x"),
    UNLINK_IN_PROGRESS,
    NO_SYNC_YET,
  ].join("\n");
  ok(!FORBIDDEN.test(everything), "NOTHING NAMES A COMMAND OR CLAUDE DESKTOP");
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
