/**
 * The status screen's wording for the profile and the Plaid keys — every
 * state, as a table.
 *
 * `status.presenter.ts` is pure functions over the domain's report objects, so
 * each state the screen can show is a fixture here rather than a profile to
 * build and break. Two properties matter beyond "the right headline":
 *
 *   1. Every state has its own headline. "No keys" and "keys Plaid rejected"
 *      are different problems with different fixes, and must never collapse.
 *   2. Nothing the screen says is the CLI's wording. The reports carry hints
 *      like "run `costingly init`" for a terminal; a window must not repeat
 *      them, and this is the check that keeps them out.
 *
 * The Database section has its own presenter and its own table:
 * desktop-database-presenter.test.mts.
 */

import type { PlaidStatus, ProfileStatus } from "../src/domain/services/status.service.js";
import type { SectionView } from "../src/apps/desktop/bridge/contract.js";
import {
  couldNotCheck,
  presentPlaid,
  presentProfile,
} from "../src/apps/desktop/main/presenters/status.presenter.js";

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
const produced: SectionView[] = [];
function view(v: SectionView): SectionView {
  produced.push(v);
  return v;
}

// ===========================================================================
// Profile
// ===========================================================================

const profileBase: ProfileStatus = {
  path: "~/AppData/Local/costingly/Data",
  chosenBy: "platform default",
  exists: false,
  createdAt: null,
  config: { exists: false, mode: null },
  clusterExists: false,
  values: [],
};

{
  const v = view(presentProfile(profileBase));
  eq(v.headline, "Not set up", "absent profile: Not set up");
  eq(v.tone, "neutral", "absent profile is a normal state, not an error");
  ok(v.details.some((d) => d.includes(profileBase.path)), "absent profile names where it would live");
  ok(!v.details.some((d) => d.includes("chosen by")), "default location is not remarked on");
}

{
  const v = view(
    presentProfile({
      ...profileBase,
      exists: true,
      createdAt: "2026-10-01",
      config: { exists: true, mode: 0o600 },
      clusterExists: true,
    }),
  );
  eq(v.headline, "Set up", "present profile: Set up");
  eq(v.tone, "good", "present profile is good");
  ok(v.details.some((d) => d.includes(profileBase.path)), "present profile names its location");
}

{
  const v = view(presentProfile({ ...profileBase, chosenBy: "COSTINGLY_HOME" }));
  ok(
    v.details.some((d) => d.includes("COSTINGLY_HOME")),
    "a moved profile says what moved it",
  );
}

// ===========================================================================
// Plaid
// ===========================================================================

{
  const v = view(
    presentPlaid({
      configured: false,
      reachable: false,
      error: "no Plaid credentials — run `costingly init`",
    } satisfies PlaidStatus),
  );
  eq(v.headline, "No keys entered", "no keys: No keys entered");
  eq(v.tone, "neutral", "no keys is a normal state");
  ok(!JSON.stringify(v).includes("costingly init"), "the CLI's hint is not repeated");
}

{
  const v = view(presentPlaid({ configured: true, reachable: true }));
  eq(v.headline, "Keys present and working", "reachable: Keys present and working");
  eq(v.tone, "good", "reachable is good");
  ok(!JSON.stringify(v).toLowerCase().includes("sandbox"), "and says nothing about a Plaid environment — there is only one");
}

{
  const v = view(
    presentPlaid({
      configured: true,
      reachable: false,
      error: "INVALID_INPUT/INVALID_API_KEYS: invalid client_id or secret provided",
    }),
  );
  eq(v.headline, "Keys present but Plaid could not be reached", "rejected keys: distinct from no keys");
  eq(v.tone, "warn", "unreachable is a warning");
  ok(v.details.some((d) => d.includes("INVALID_API_KEYS")), "unreachable carries Plaid's reason");
}

// ===========================================================================
// A check that threw
// ===========================================================================

{
  const v = view(couldNotCheck(new Error("boom")));
  eq(v.headline, "Could not check", "a thrown check: Could not check");
  eq(v.tone, "bad", "a thrown check is bad");
  eq(v.details, ["boom"], "a thrown check shows the message");
  eq(couldNotCheck("plain string").details, ["plain string"], "a non-Error throw is shown as text");
}

// ===========================================================================
// No CLI wording anywhere
// ===========================================================================

const CLI_WORDING = /costingly\s+(init|migrate|status|stop|sync|link|unlink|uninstall|reset|seed)\b|`|Claude Desktop/;
eq(
  produced.flatMap((v) => [v.headline, ...v.details]).filter((line) => CLI_WORDING.test(line)),
  [],
  `${produced.length} views produced, and none tells the user to run a command`,
);

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
