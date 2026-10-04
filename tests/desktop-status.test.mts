/**
 * The status screen's wording — every state, as a table.
 *
 * `status-view.ts` is pure functions over the domain's report objects, so each
 * state the screen can show is a fixture here rather than a database to build
 * and break. Two properties matter beyond "the right headline":
 *
 *   1. Every state has its own headline. "Stopped" and "Not created" are
 *      different problems with different fixes, and must never collapse.
 *   2. Nothing the screen says is the CLI's wording. The reports carry hints
 *      like "run `costingly init`" for a terminal; a window must not repeat
 *      them, and this is the check that keeps them out.
 */

import type { DatabaseHealth } from "../src/domain/services/database/database-health.service.js";
import type { PlaidStatus, ProfileStatus } from "../src/domain/services/status.service.js";
import type { SectionView } from "../src/apps/desktop/status-view.types.js";
import {
  couldNotCheck,
  databaseView,
  plaidView,
  profileView,
} from "../src/apps/desktop/status-view.js";

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
  const v = view(profileView(profileBase));
  eq(v.headline, "Not set up", "absent profile: Not set up");
  eq(v.tone, "neutral", "absent profile is a normal state, not an error");
  ok(v.details.some((d) => d.includes(profileBase.path)), "absent profile names where it would live");
  ok(!v.details.some((d) => d.includes("chosen by")), "default location is not remarked on");
}

{
  const v = view(
    profileView({
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
  const v = view(profileView({ ...profileBase, chosenBy: "COSTINGLY_HOME" }));
  ok(
    v.details.some((d) => d.includes("COSTINGLY_HOME")),
    "a moved profile says what moved it",
  );
}

// ===========================================================================
// Database
// ===========================================================================

const dbBase: DatabaseHealth = {
  profile: { path: "~/AppData/Local/costingly/Data", chosenBy: "platform default", exists: true },
  cluster: {
    path: "~/AppData/Local/costingly/Data/pg18",
    exists: true,
    state: "running",
    listenAddress: "127.0.0.1:54320",
    startedAt: "2026-10-03 09:00",
    uptimeSeconds: 3725,
  },
  connection: { ok: true, elapsedMs: 12 },
  migrationsApplied: ["0001-initial", "0002-item-source"],
};

{
  const v = view(
    databaseView({
      ...dbBase,
      cluster: { ...dbBase.cluster, exists: false, state: "uninitialised", startedAt: null, uptimeSeconds: null },
      connection: { ok: false },
      migrationsApplied: null,
    }),
  );
  eq(v.headline, "Not created", "no cluster: Not created");
  eq(v.tone, "neutral", "no cluster is a normal state");
}

{
  const v = view(
    databaseView({
      ...dbBase,
      cluster: { ...dbBase.cluster, state: "stopped", startedAt: null, uptimeSeconds: null },
      connection: { ok: false, error: "ECONNREFUSED" },
      migrationsApplied: null,
    }),
  );
  eq(v.headline, "Stopped", "stopped server: Stopped — distinct from Not created");
  eq(v.tone, "warn", "stopped is a warning, not an error");
}

{
  const v = view(databaseView(dbBase));
  eq(v.headline, "Running", "running and answering: Running");
  eq(v.tone, "good", "running is good");
  ok(v.details.some((d) => d.includes("127.0.0.1:54320")), "running says where it listens");
  ok(v.details.some((d) => d.includes("1h 2m")), "running says for how long");
  ok(v.details.some((d) => d.includes("0002-item-source")), "running names the schema version");
}

{
  const v = view(databaseView({ ...dbBase, migrationsApplied: [] }));
  ok(v.details.some((d) => /no tables/i.test(d)), "an empty schema is said out loud");
}

{
  const v = view(
    databaseView({
      ...dbBase,
      cluster: { ...dbBase.cluster, startedAt: null, uptimeSeconds: null },
      connection: { ok: false, elapsedMs: 15000, error: "no response after 15000ms" },
      migrationsApplied: null,
    }),
  );
  eq(v.headline, "Running but not answering", "up but wedged: its own headline");
  eq(v.tone, "bad", "not answering is bad");
  ok(v.details.some((d) => d.includes("15000ms")), "not answering carries the reason");
}

{
  const v = view(
    databaseView({
      ...dbBase,
      cluster: { ...dbBase.cluster, state: "unknown", error: "pg_ctl: not found", startedAt: null, uptimeSeconds: null },
      connection: { ok: false },
      migrationsApplied: null,
    }),
  );
  eq(v.headline, "Could not check", "pg_ctl itself failed: Could not check");
  eq(v.tone, "bad", "could not check is bad");
  ok(v.details.some((d) => d.includes("pg_ctl: not found")), "could not check carries the reason");
}

// ===========================================================================
// Plaid
// ===========================================================================

{
  const v = view(
    plaidView({
      configured: false,
      environment: "production",
      reachable: false,
      error: "no Plaid credentials — run `costingly init`",
    }),
  );
  eq(v.headline, "No keys entered", "no keys: No keys entered");
  eq(v.tone, "neutral", "no keys is a normal state");
  ok(!JSON.stringify(v).includes("costingly init"), "the CLI's hint is not repeated");
}

{
  const v = view(plaidView({ configured: true, environment: "production", reachable: true }));
  eq(v.headline, "Keys present and working", "reachable: Keys present and working");
  eq(v.tone, "good", "reachable is good");
  ok(v.details.some((d) => d.includes("production")), "reachable names the environment");
}

{
  const v = view(
    plaidView({
      configured: true,
      environment: "production",
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
none(
  produced.flatMap((v) => [v.headline, ...v.details]).filter((line) => CLI_WORDING.test(line)),
  `${produced.length} views produced, and none tells the user to run a command`,
);

function none(offenders: string[], what: string): void {
  eq(offenders, [], what);
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
