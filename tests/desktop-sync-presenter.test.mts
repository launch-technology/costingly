/**
 * How a sync is worded on the Accounts screen — every case, as a table.
 *
 * `sync.presenter.ts` is pure functions over the service's state and the
 * domain's summary, so each thing a sync can do is a fixture here. What
 * matters beyond "the right text":
 *
 *   1. Nothing new is "Up to date", never "0 added".
 *   2. A history Plaid is still preparing is said as that.
 *   3. An expired login is an instruction, not an error message.
 *   4. A failure every bank shares is said once, and an expired login is
 *      never folded into it.
 *   5. Nothing is the CLI's wording.
 */

import type { ItemSyncResult, SyncSummary } from "../src/domain/services/banks/sync.types.js";
import type { SyncView } from "../src/apps/desktop/bridge/contract.js";
import { presentSync } from "../src/apps/desktop/main/presenters/sync.presenter.js";

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

/** Every view produced, for the wording sweep at the end. */
const produced: SyncView[] = [];

function bank(id: string, change: Partial<ItemSyncResult> = {}): ItemSyncResult {
  return {
    itemId: id,
    institutionName: `Bank ${id}`,
    ok: true,
    added: 0,
    modified: 0,
    removed: 0,
    accounts: 1,
    pages: 1,
    initialBackfill: false,
    updateStatus: null,
    ...change,
  };
}
const failed = (id: string, error: string): ItemSyncResult => bank(id, { ok: false, error });

function finished(results: ItemSyncResult[]): Extract<SyncView, { state: "finished" }> {
  const succeeded = results.filter((result) => result.ok).length;
  const summary: SyncSummary = {
    ok: succeeded === results.length,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    itemsTotal: results.length,
    itemsSucceeded: succeeded,
    itemsFailed: results.length - succeeded,
    added: 0,
    modified: 0,
    removed: 0,
    results,
  };
  const view = presentSync({ phase: "finished", trigger: "manual", summary });
  produced.push(view);
  if (view.state !== "finished") throw new Error(`expected a finished view, got ${view.state}`);
  return view;
}
const number = (value: number): string => new Intl.NumberFormat().format(value);

// ===========================================================================
// Not finished
// ===========================================================================

eq(presentSync({ phase: "idle" }), { state: "idle" }, "idle: nothing to show");
eq(
  presentSync({ phase: "running", trigger: "manual", startedAt: new Date() }),
  { state: "running" },
  "running: says only that — there is no progress to report",
);

// ===========================================================================
// Everything worked
// ===========================================================================

{
  const view = finished([
    bank("a"),
    bank("b", { added: 12 }),
    bank("c", { added: 1234, modified: 3, removed: 1 }),
  ]);
  eq([view.tone, view.summary], ["good", "Synced 3 banks."], "all worked: one good line for the run");
  eq(view.problem, undefined, "with no problem");
  eq(view.results[0], { bankId: "a", tone: "good", text: "Up to date." }, "NOTHING NEW IS 'Up to date', not '0 added'");
  eq(view.results[1]?.text, "12 new.", "new transactions are counted");
  eq(view.results[2]?.text, `${number(1234)} new, 3 updated, 1 removed.`, "and so are updated and removed ones, with large counts grouped");
}

eq(finished([bank("only")]).summary, "Synced 1 bank.", "one bank is '1 bank', not '1 banks'");

// ===========================================================================
// A history Plaid has not finished collecting
// ===========================================================================

{
  const view = finished([
    bank("new", { updateStatus: "NOT_READY" as ItemSyncResult["updateStatus"] }),
    bank("partial", { added: 16, updateStatus: "NOT_READY" as ItemSyncResult["updateStatus"] }),
  ]);
  eq(
    view.results[0],
    { bankId: "new", tone: "warn", text: "This bank is still preparing its history. Sync again in a few minutes." },
    "A HISTORY NOT READY IS SAID AS THAT, not as 'Up to date'",
  );
  eq(
    view.results[1]?.text,
    "16 new so far. This bank is still preparing its history. Sync again in a few minutes.",
    "what has arrived is counted as 'so far'",
  );
  eq(view.tone, "good", "the run itself still worked");
}

// ===========================================================================
// Some banks failed
// ===========================================================================

{
  const view = finished([bank("a", { added: 2 }), failed("b", "INSTITUTION_ERROR/INSTITUTION_DOWN: the bank is not responding")]);
  eq([view.tone, view.summary], ["warn", "Synced 1 of 2 banks. 1 could not be synced."], "one failed: the run says how many");
  eq(view.problem, undefined, "it is that bank's problem, not the run's");
  eq(view.results[0]?.text, "2 new.", "THE BANK THAT WORKED STILL SHOWS ITS RESULT");
  eq(
    view.results[1],
    { bankId: "b", tone: "bad", text: "Could not sync: INSTITUTION_ERROR/INSTITUTION_DOWN: the bank is not responding" },
    "the one that failed says why",
  );
}

// ===========================================================================
// An expired login
// ===========================================================================

const EXPIRED = "ITEM_ERROR/ITEM_LOGIN_REQUIRED: the login details of this item have changed";
{
  const view = finished([bank("a"), failed("b", EXPIRED)]);
  eq(
    view.results[1],
    { bankId: "b", tone: "warn", text: "Your bank login has expired, so this bank was not synced. Reconnect it, then sync again." },
    "AN EXPIRED LOGIN IS AN INSTRUCTION, not Plaid's error text",
  );
}
{
  const view = finished([failed("only", EXPIRED)]);
  eq(view.problem, undefined, "an expired login is never a run-wide problem, even with one bank");
  ok(/login has expired/.test(view.results[0]?.text ?? ""), "it stays on the bank it belongs to");
}

// ===========================================================================
// Every bank failed the same way
// ===========================================================================

{
  const view = finished([failed("a", "getaddrinfo ENOTFOUND production.plaid.com"), failed("b", "getaddrinfo ENOTFOUND production.plaid.com")]);
  eq([view.tone, view.summary], ["bad", "No bank was synced."], "all failed alike: one line");
  ok(view.problem?.cause.includes("ENOTFOUND") === true, "A SHARED FAILURE IS SAID ONCE, with the reason");
  ok(/internet connection/.test(view.problem?.nextStep ?? ""), "and what to check");
  eq(view.results.map((result) => result.text), ["Not synced.", "Not synced."], "each bank says only that it was not synced");
}
eq(finished([failed("only", "INVALID_INPUT/INVALID_API_KEYS: invalid client_id or secret provided")]).summary, "The bank was not synced.", "one bank, failed: worded for one");
{
  const view = finished([failed("a", "one reason"), failed("b", "another reason")]);
  eq(view.problem, undefined, "different reasons are NOT folded together");
  eq(view.results.map((result) => result.text), ["Could not sync: one reason", "Could not sync: another reason"], "each bank keeps its own");
  eq(view.summary, "Synced 0 of 2 banks. 2 could not be synced.", "and the run says none worked");
}
{
  const view = finished([failed("a", "no network"), failed("b", EXPIRED)]);
  eq(view.problem, undefined, "an expired login among other failures keeps every bank's own line");
}

// ===========================================================================
// Nothing to sync, and a sync that could not run
// ===========================================================================

{
  const view = finished([]);
  eq(view.tone, "neutral", "no banks in the run: not a failure");
  ok(/needs attention/.test(view.summary), "it says a bank that needs attention is skipped");
}
{
  const view = presentSync({ phase: "failed", trigger: "manual", reason: "connect ECONNREFUSED 127.0.0.1:54320" });
  produced.push(view);
  ok(view.state === "finished" && view.tone === "bad", "a sync that could not run is a finished, bad result");
  if (view.state === "finished") {
    ok(view.problem?.cause.includes("ECONNREFUSED") === true, "with the reason");
    ok(/Status screen/.test(view.problem?.nextStep ?? ""), "and it points to the Status screen");
    eq(view.results, [], "and no per-bank results");
  }
}

// ===========================================================================
// Every problem has both halves, and nothing is CLI wording
// ===========================================================================

const finishedViews = produced.filter((view): view is Extract<SyncView, { state: "finished" }> => view.state === "finished");
const problems = finishedViews.flatMap((view) => (view.problem === undefined ? [] : [view.problem]));
eq(problems.filter((p) => p.cause.trim() === "" || p.nextStep.trim() === ""), [], `${problems.length} problems, each with a cause and a next step`);

const CLI_WORDING = /costingly\s+(init|migrate|status|stop|sync|link|unlink|uninstall|reset|seed)\b|`|Claude Desktop/;
const said = finishedViews.flatMap((view) => [
  view.summary,
  ...(view.problem === undefined ? [] : [view.problem.cause, view.problem.nextStep]),
  ...view.results.map((result) => result.text),
]);
eq(said.filter((line) => CLI_WORDING.test(line)), [], `${said.length} lines produced, and none tells the user to run a command`);

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
