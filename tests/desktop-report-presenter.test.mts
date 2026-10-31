/**
 * The copied report's wording — a table.
 *
 * The facts come from features/logs/report.service.ts; this checks that each is
 * said, that a part that could not be read is said as such, and above all
 * what is NOT said: no account name, number or balance, no key, no password,
 * no command.
 */

import { copyFailed, presentReport } from "../src/apps/desktop/main/features/logs/report.presenter.js";
import type { Report } from "../src/apps/desktop/main/features/logs/report.service.js";

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
const has = (text: string, needle: string | RegExp, what: string): void =>
  ok(typeof needle === "string" ? text.includes(needle) : needle.test(text), `${what} (${needle})`);
const lacks = (text: string, needle: string, what: string): void => ok(!text.includes(needle), `${what} (${needle})`);

const SECRET = "plaid-secret-value-zzz";
const PASSWORD = "p4ss-generated-zzz";

const ready: Report = {
  version: "1.6.4",
  generatedAt: new Date("2026-10-10T09:05:00"),
  profile: {
    ok: true,
    value: {
      path: "~/AppData/Local/costingly/Data",
      chosenBy: "platform default",
      exists: true,
      createdAt: "2026-10-01",
      config: { exists: true, mode: 0o600 },
      clusterExists: true,
      values: [
        { key: "plaidClientId", source: "config file", display: "abc123clientid" },
        { key: "plaidSecret", source: "config file", display: "set" },
        { key: "encryptionKey", source: "config file", display: "set" },
      ],
    },
  },
  database: {
    ok: true,
    value: {
      checked: true,
      health: {
        profile: { path: "~/AppData/Local/costingly/Data", chosenBy: "platform default", exists: true },
        cluster: {
          path: "~/AppData/Local/costingly/Data/pg18",
          exists: true,
          state: "running",
          listenAddress: "127.0.0.1:54320",
          startedAt: "2026-10-10T08:00:00.000Z",
          uptimeSeconds: 3900,
        },
        connection: { ok: true, elapsedMs: 4 },
        migrationsApplied: ["001_init", "002_views"],
      },
    },
  },
  plaid: { ok: true, value: { configured: true, reachable: true } },
  banks: {
    ok: true,
    value: [
      row("i1", "Test Bank", "a1", "Everyday Checking", "4321", "1234.56", "2026-10-09T20:00:00.000Z", "active"),
      row("i1", "Test Bank", "a2", "Rainy Day Savings", "9876", "9999.00", "2026-10-09T20:00:00.000Z", "active"),
      row("i2", "Other Bank", "a3", "Travel Card", "1111", "-250.00", null, "login_required"),
    ],
  },
  appLog: { ok: true, state: "lines", lines: ["2026-10-10 09:00:00 INFO  Costingly 1.6.4 starting", "2026-10-10 09:00:02 INFO  the database started"], path: "~/AppData/Local/costingly/Desktop/costingly.log" } as never,
  databaseLog: { state: "empty", path: "~/AppData/Local/costingly/Data/pg18.log" },
};
// LogExcerpt has no `ok`; the cast above keeps the literal honest for the type checker without widening the test.
delete (ready.appLog as unknown as Record<string, unknown>)["ok"];

function row(
  item: string,
  bank: string,
  account: string,
  name: string,
  mask: string,
  balance: string,
  synced: string | null,
  status: string,
): Report["banks"] extends { ok: true; value: Array<infer R> } | { ok: false; reason: string } ? R : never {
  return {
    item_id: item,
    institution_name: bank,
    status,
    last_synced_at: synced === null ? null : new Date(synced),
    never_synced: synced === null,
    source: "plaid",
    account_id: account,
    account_name: name,
    mask,
    type: "depository",
    subtype: "checking",
    currency: "USD",
    current_balance: balance,
    balance_updated_at: null,
    txn_count: "120",
    first_date: "2026-01-01",
    last_date: "2026-10-09",
  };
}

// --- the ready case: every fact is said --------------------------------------
{
  const text = presentReport(ready);
  has(text, "Costingly 1.6.4", "the header names the version");
  has(text, "2026-10-10 09:05:00", "and when the report was made");
  has(text, "== Profile ==", "a profile section");
  has(text, "Location: ~/AppData/Local/costingly/Data", "with the location");
  has(text, "Settings file: present, permissions 600", "and the settings file's presence and permissions");
  has(text, "plaidClientId: abc123clientid (config file)", "the client ID, which is not a secret, in full");
  has(text, "plaidSecret: set (config file)", "the secret as present, never its value");
  has(text, "== Database ==", "a database section");
  has(text, "State: running", "with its state");
  has(text, "Connection: answered in 4 ms on 127.0.0.1:54320", "the connection");
  has(text, "Up since: 2026-10-10T08:00:00.000Z (1 h 5 min)", "the uptime");
  has(text, "Schema: 001_init, 002_views", "and the schema");
  has(text, "== Plaid ==", "a Plaid section");
  has(text, "Keys: present", "keys present");
  has(text, "Plaid: answered", "and Plaid answering");
  has(text, "== Linked banks ==", "a banks section");
  has(text, "Test Bank: 2 accounts, last synced 2026-10-09", "EACH BANK BY NAME with its account count and last sync");
  has(text, /Other Bank: 1 account, last synced never, NEEDS ATTENTION \(login expired\)/, "a bank whose login expired says so");
  has(text, "== App log (last 2 lines) ==", "the app log section counts its lines");
  has(text, "From ~/AppData/Local/costingly/Desktop/costingly.log:", "and names the file");
  has(text, "2026-10-10 09:00:02 INFO  the database started", "with the lines as written");
  has(text, "== Database log (last 0 lines) ==", "the database log section");
  has(text, "The database has not written a log yet. It will be at ~/AppData/Local/costingly/Data/pg18.log", "with the empty wording and where the file will be");
  ok(text.endsWith("\n"), "the text ends with a line break, ready to paste");

  // --- what is not said ---
  lacks(text, "Everyday Checking", "NO ACCOUNT NAME");
  lacks(text, "Rainy Day", "no account name, any of them");
  lacks(text, "4321", "NO ACCOUNT NUMBER OR MASK");
  lacks(text, "1234.56", "NO BALANCE");
  lacks(text, "9999", "no balance, any of them");
  lacks(text, "txn", "nothing about transactions");
  lacks(text, SECRET, "no secret value");
  lacks(text, PASSWORD, "no password");
  ok(!/costingly\s+(init|status|sync|link|unlink|uninstall|reset|seed)\b|`|Claude Desktop/.test(text), "and no CLI wording");
}

// --- a part that could not be read -----------------------------------------
{
  const text = presentReport({
    ...ready,
    profile: { ok: false, reason: "EACCES: permission denied" },
    banks: { ok: false, reason: "the database is not running" },
    plaid: { ok: false, reason: "boom" },
  });
  has(text, "The profile could not be read: EACCES: permission denied", "an unavailable profile is one line with its reason");
  has(text, "The banks could not be read: the database is not running", "an unavailable bank list likewise");
  has(text, "The Plaid could not be read: boom".replace("The Plaid", "The Plaid"), "and Plaid");
  has(text, "State: running", "while the parts that were read are still said");
}

// --- the database: not checked, with the remembered failure ----------------
{
  const text = presentReport({
    ...ready,
    database: { ok: true, value: { checked: false, failure: { kind: "port-in-use", reason: "could not bind", port: 54320 } } },
  });
  has(text, "State: stopped", "a database known to have failed to start is stopped");
  has(
    text,
    "Last start: Port in use. Another program is using port 54320, which the database needs.",
    "with the remembered failure, naming the port — in the Status screen's own words",
  );
  lacks(text, "Connection:", "and no connection line, since none was tried");
}
{
  const text = presentReport({
    ...ready,
    database: { ok: true, value: { checked: false, failure: { kind: "will-not-start", reason: "exit code 1" } } },
  });
  has(text, "Last start: Could not start. The database did not start. exit code 1", "will-not-start, worded the same way, with its reason");
}
{
  const text = presentReport({ ...ready, database: { ok: false, reason: "pg_ctl: not found" } });
  has(text, "The database could not be read: pg_ctl: not found", "a database check that threw is its reason");
}

// --- the other states --------------------------------------------------------
{
  const text = presentReport({
    ...ready,
    plaid: { ok: true, value: { configured: false, reachable: false } },
    banks: { ok: true, value: [] },
    appLog: { state: "unreadable", path: "~/x/costingly.log" },
    profile: {
      ok: true,
      value: { path: "~/x/Data", chosenBy: "COSTINGLY_HOME", exists: false, createdAt: null, config: { exists: false, mode: null }, clusterExists: false, values: [] },
    },
  });
  has(text, "Keys: none entered", "no keys: said");
  has(text, "Plaid: not asked", "and Plaid was not asked");
  has(text, "No banks are linked.", "no banks: said");
  has(text, "The app log could not be read. It should be at ~/x/costingly.log", "an unreadable log says so and where it should be");
  has(text, "Location: ~/x/Data (chosen by COSTINGLY_HOME)", "a profile chosen by the home variable says so");
  has(text, "Not created yet.", "and one that does not exist says so");
}
{
  const text = presentReport({
    ...ready,
    plaid: { ok: true, value: { configured: true, reachable: false, error: "ETIMEDOUT" } },
  });
  has(text, "Plaid: did not answer — ETIMEDOUT", "keys present but Plaid silent: the reason");
}

// --- a copy that failed -------------------------------------------------------
{
  const problem = copyFailed("The report", "the clipboard is in use");
  eq(problem.cause, "The report could not be copied: the clipboard is in use", "a failed copy names what and why");
  ok(/Try again/.test(problem.nextStep) && /by hand/.test(problem.nextStep), "and says what to do, including the fallback of selecting the text");
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
