/**
 * Drive the clack account picker with synthetic keystrokes, using clack's
 * supported input/output injection. No TTY, no `script`, no timing races.
 */

import { PassThrough } from "node:stream";
import { pickAccounts, pickWindow, type AccountRow } from "../cli/transactions.js";

const KEY = { down: "[B", up: "[A", enter: "\r", ctrlC: "" };

const ACCOUNTS: AccountRow[] = [
  { account_id: "acct-401k", name: "Plaid 401k", mask: "6666", type: "investment",
    subtype: "401k", currency: "USD", current_balance: "23631.9805",
    institution_name: "Bank of America", txn_count: "0" },
  { account_id: "acct-chk", name: "Plaid Checking", mask: "0000", type: "depository",
    subtype: "checking", currency: "USD", current_balance: "110.0000",
    institution_name: "Bank of America", txn_count: "145" },
];

const results: string[] = [];
let failures = 0;

function eq(actual: unknown, expected: unknown, what: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) results.push(`  ok    ${what}`);
  else {
    failures += 1;
    results.push(`  FAIL  ${what}\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Run the picker, feeding `keys` once it has rendered. Returns chosen ids. */
async function drive(keys: string[], accounts = ACCOUNTS): Promise<string[] | null> {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // drain the rendered frames

  const pending = pickAccounts(accounts, {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });

  // Let clack render and attach its key listener before typing.
  for (const key of keys) {
    await new Promise((resolve) => setImmediate(resolve));
    input.write(key);
  }

  const chosen = await pending;
  return chosen === null ? null : chosen.map((a) => a.account_id);
}

/** Capture what the menu actually renders. */
async function render(accounts = ACCOUNTS): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let frames = "";
  output.on("data", (chunk: Buffer) => { frames += chunk.toString(); });

  const pending = pickAccounts(accounts, {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  await new Promise((resolve) => setImmediate(resolve));
  input.write(KEY.enter);
  await pending;

  // eslint-disable-next-line no-control-regex
  return frames.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

eq(await drive([KEY.enter]), ["acct-401k"], "enter selects the first option");
eq(await drive([KEY.down, KEY.enter]), ["acct-chk"], "down+enter selects the second");
eq(await drive([KEY.down, KEY.down, KEY.enter]), ["acct-401k", "acct-chk"], "down x2 = All accounts");
eq(await drive([KEY.down, KEY.up, KEY.enter]), ["acct-401k"], "up navigates back");
eq(await drive([KEY.ctrlC]), null, "ctrl-c cancels");

// Wrap-around: from the first item, up should land on the last (All accounts).
eq(await drive([KEY.up, KEY.enter]), ["acct-401k", "acct-chk"], "up from the top wraps to All accounts");

const frame = await render();
eq(frame.includes("Plaid Checking ••0000"), true, "renders account label with mask");
eq(frame.includes("All accounts"), true, "renders the All accounts entry");
eq(frame.includes("$110.00"), true, "renders balance hint");
eq(frame.includes("145 txns"), true, "renders transaction count hint");
eq(frame.includes("Bank of America"), false, "single bank: bank name omitted from labels");

// With two banks the name must come back, or the rows are ambiguous.
const twoBanks: AccountRow[] = [
  ACCOUNTS[0]!,
  { ...ACCOUNTS[1]!, institution_name: "Chase" },
];
const twoBankFrame = await render(twoBanks);
eq(twoBankFrame.includes("Bank of America · Plaid 401k"), true, "two banks: bank name shown");
eq(twoBankFrame.includes("Chase · Plaid Checking"), true, "two banks: second bank shown");

// --- window prompt -------------------------------------------------------
async function driveWindow(keys: string[]): Promise<number | string | null> {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const pending = pickWindow({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  for (const key of keys) {
    await new Promise((resolve) => setImmediate(resolve));
    input.write(key);
  }
  return await pending;
}

eq(await driveWindow([KEY.enter]), 7, "window: enter takes the default 7 days");
eq(await driveWindow([KEY.down, KEY.enter]), 14, "window: down = 14 days");
eq(await driveWindow([KEY.down, KEY.down, KEY.enter]), 30, "window: down x2 = 30 days");
eq(await driveWindow([KEY.up, KEY.enter]), "all", "window: up from top wraps to All time");
eq(await driveWindow([KEY.ctrlC]), null, "window: ctrl-c cancels");

console.log(results.slice(-5).join("\n"));
console.log(failures === 0 ? `\nAll ${results.length} checks passed.` : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
