/**
 * The Settings screen's wording — a short table.
 *
 * Most of the screen is facts shown as facts. What is worded is the failure
 * to change start-at-sign-in, which must carry the reason, say what to do,
 * and report the switch as Windows has it.
 */

import { presentSettings, presentStartAtSignIn } from "../src/apps/desktop/main/presenters/settings.presenter.js";

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

const reading = { plaidClientId: "client-id-123", startAtSignIn: false, version: "1.6.4", dataFolder: "~/costingly/Data" };
eq(presentSettings(reading), reading, "the facts pass through as they are");
eq(presentSettings({ ...reading, plaidClientId: null }).plaidClientId, null, "no saved keys stays null for the screen to word");
{
  const view = presentSettings({ ...reading, plaidClientId: null, plaidKeysUnreadable: "config.json is not valid JSON" });
  ok(view.plaidProblem?.cause.includes("could not be read") === true && view.plaidProblem.cause.includes("not valid JSON"), "keys that could not be read are worded as a problem, with the reason");
  ok(/Enter your keys below/.test(view.plaidProblem?.nextStep ?? ""), "and what to do");
  eq("plaidKeysUnreadable" in view, false, "the raw reason does not travel on to the window");
}

eq(presentStartAtSignIn({ changed: true, on: true }), { outcome: "set", on: true }, "a change that took: set, on");
eq(presentStartAtSignIn({ changed: true, on: false }), { outcome: "set", on: false }, "a change that took: set, off");
{
  const failed = presentStartAtSignIn({ changed: false, on: false, reason: "Access is denied." });
  ok(failed.outcome === "failed", "a change Windows refused: failed");
  if (failed.outcome === "failed") {
    eq(failed.on, false, "REPORTING THE SWITCH AS WINDOWS HAS IT");
    ok(failed.problem.cause.includes("Access is denied."), "with the reason");
    ok(/Try again/.test(failed.problem.nextStep), "and what to do");
    ok(failed.problem.cause.trim() !== "" && failed.problem.nextStep.trim() !== "", "both halves present");
    const CLI_WORDING = /costingly\s+(init|migrate|status|stop|sync|link|unlink|uninstall|reset|seed)\b|`|Claude Desktop/;
    ok(!CLI_WORDING.test(failed.problem.cause + failed.problem.nextStep), "and none of it is CLI wording");
  }
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
