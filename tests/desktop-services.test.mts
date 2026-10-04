/**
 * The desktop app's services and adapters, without a window.
 *
 * Everything under `src/apps/desktop/main/{services,adapters}` is handed what
 * it depends on, so each piece can be given a collaborator that misbehaves on
 * demand: a Plaid that never answers, an install that fails, a datastore that
 * cannot be asked. Those are exactly the cases a real profile cannot be made
 * to produce, and the ones a window suite cannot reach.
 *
 *   1. SetupService           the order of setup, and what it does at each fork
 *   2. PlaidKeyVerifier       rejected vs unreachable; nothing left behind
 *   3. DatabaseLifetime       starts what exists, stops what runs, never throws
 *   4. CloseNoticeService     once
 *   5. SettingsService        forgiving on read
 *   6. The real wiring        the same service over the real domain, on a
 *                             throwaway profile — asking must create nothing
 *
 * Runs on every platform: nothing here imports Electron, which the
 * architecture suite enforces.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = join(tmpdir(), "costingly-desktop-services");
process.env["COSTINGLY_HOME"] = HOME;
delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { configStore } = await import("../src/index.js");
const { SetupService } = await import("../src/apps/desktop/main/services/setup.service.js");
const { DatabaseLifetimeService } = await import(
  "../src/apps/desktop/main/services/database-lifetime.service.js"
);
const { CloseNoticeService } = await import("../src/apps/desktop/main/services/close-notice.service.js");
const { SettingsService } = await import("../src/apps/desktop/main/services/settings.service.js");
const { PlaidKeyVerifier, classifyKeyFailure } = await import(
  "../src/apps/desktop/main/adapters/plaid-key-verifier.js"
);
const domain = await import("../src/apps/desktop/main/adapters/domain.js");

type SetupDependencies = import("../src/apps/desktop/main/services/setup.service.js").SetupDependencies;
type KeyVerdict = import("../src/apps/desktop/main/services/setup.service.js").KeyVerdict;
type StoredConfig = import("../src/domain/config.js").StoredConfig;
type DatastoreState = import("../src/platform/datastore/datastore.js").DatastoreState;

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

await rm(HOME, { recursive: true, force: true });

// ===========================================================================
// 1. SetupService
// ===========================================================================

interface Fake {
  deps: SetupDependencies;
  written: StoredConfig[];
  verified: Array<[string, string]>;
}

/** A machine with nothing set up and a Plaid that accepts anything. */
function fake(overrides: {
  status?: () => Promise<DatastoreState>;
  sources?: Partial<Record<"plaidClientId" | "plaidSecret", "missing" | "config file">>;
  verdict?: KeyVerdict;
  existingKey?: string;
  install?: () => Promise<void>;
  write?: () => Promise<void>;
  dataDirExists?: boolean;
} = {}): Fake {
  const written: StoredConfig[] = [];
  const verified: Array<[string, string]> = [];
  const sources: Record<"plaidClientId" | "plaidSecret", "missing" | "config file"> = {
    plaidClientId: "missing",
    plaidSecret: "missing",
    ...overrides.sources,
  };

  const deps: SetupDependencies = {
    datastore: {
      status: overrides.status ?? (async () => "uninitialised"),
      dataDir: () => "/profile/pg18",
    },
    config: {
      describe: () => [
        { key: "plaidClientId", source: sources.plaidClientId, display: "" },
        { key: "plaidSecret", source: sources.plaidSecret, display: "" },
      ],
      readFile: () => (overrides.existingKey === undefined ? {} : { encryptionKey: overrides.existingKey }),
      write:
        overrides.write ??
        (async (values) => {
          written.push(values);
        }),
      plaidEnv: () => "sandbox",
    },
    keys: {
      verify: async (clientId, secret) => {
        verified.push([clientId, secret]);
        return overrides.verdict ?? { accepted: true };
      },
    },
    install: overrides.install ?? (async () => {}),
    newEncryptionKey: () => "freshly-generated-key",
    dataFolder: () => "~/profile",
    pathExists: () => overrides.dataDirExists ?? false,
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
  };

  return { deps, written, verified };
}

// --- what is set up ---------------------------------------------------------
{
  const state = await new SetupService(fake().deps).state();
  eq(state, { keysPresent: false, databaseCreated: false, dataFolder: "~/profile" }, "nothing set up: no keys, no database");
}
{
  const { deps } = fake({ sources: { plaidClientId: "config file" } });
  eq((await new SetupService(deps).state()).keysPresent, false, "a client ID without a secret is not keys");
}
{
  const { deps } = fake({ sources: { plaidClientId: "config file", plaidSecret: "config file" } });
  eq((await new SetupService(deps).state()).keysPresent, true, "both keys present: keys present");
}
for (const status of ["stopped", "running"] as const) {
  const { deps } = fake({ status: async () => status });
  eq((await new SetupService(deps).state()).databaseCreated, true, `a ${status} database counts as created`);
}
{
  const boom = async (): Promise<DatastoreState> => {
    throw new Error("pg_ctl: not found");
  };
  eq(
    (await new SetupService(fake({ status: boom, dataDirExists: true }).deps).state()).databaseCreated,
    true,
    "the datastore cannot be asked, but its folder exists: created — never offer to create over one",
  );
  eq(
    (await new SetupService(fake({ status: boom, dataDirExists: false }).deps).state()).databaseCreated,
    false,
    "…and with no folder either: not created",
  );
}

// --- the keys ---------------------------------------------------------------
{
  const f = fake();
  const result = await new SetupService(f.deps).submitKeys("   ", "secret");
  eq(result.outcome, "rejected", "a blank client ID is refused");
  eq(f.verified.length, 0, "…WITHOUT ASKING PLAID");
  eq(f.written.length, 0, "…and nothing is saved");
}
{
  const f = fake({ verdict: { accepted: false, kind: "rejected", reason: "INVALID_API_KEYS" } });
  const result = await new SetupService(f.deps).submitKeys("id", "secret");
  eq(result, { outcome: "rejected", reason: "INVALID_API_KEYS" }, "Plaid rejects: rejected, with Plaid's reason");
  eq(f.written.length, 0, "…AND NOTHING IS SAVED");
}
{
  const f = fake({ verdict: { accepted: false, kind: "unreachable", reason: "ENOTFOUND" } });
  const result = await new SetupService(f.deps).submitKeys("id", "secret");
  eq(result, { outcome: "unreachable", reason: "ENOTFOUND" }, "Plaid does not answer: unreachable — distinct from rejected");
  eq(f.written.length, 0, "…and nothing is saved");
}
{
  const f = fake();
  const result = await new SetupService(f.deps).submitKeys("  id  ", "  secret  ");
  eq(result, { outcome: "accepted" }, "Plaid accepts: accepted");
  eq(f.verified, [["id", "secret"]], "the keys are trimmed before Plaid sees them");
  eq(
    f.written,
    [{ plaidClientId: "id", plaidSecret: "secret", encryptionKey: "freshly-generated-key", plaidEnv: "sandbox" }],
    "saved once: the keys, a new encryption key, and the environment the check ran against",
  );
}
{
  const f = fake({ existingKey: "the-key-already-there" });
  await new SetupService(f.deps).submitKeys("id", "secret");
  eq(f.written[0]?.encryptionKey, "the-key-already-there", "AN EXISTING ENCRYPTION KEY IS NEVER REPLACED");
}
{
  const f = fake({
    write: async () => {
      throw new Error("EACCES: permission denied");
    },
  });
  const result = await new SetupService(f.deps).submitKeys("id", "secret");
  eq(result.outcome, "unreachable", "accepted by Plaid but the save failed: not reported as rejected keys");
  ok(
    result.outcome !== "accepted" && result.reason.includes("could not be saved") && result.reason.includes("EACCES"),
    "…and the reason says the save failed, and why",
  );
}

// --- the database -----------------------------------------------------------
{
  eq(await new SetupService(fake().deps).createDatabase(), { outcome: "ready" }, "install succeeds: ready");
  const failing = fake({
    install: async () => {
      throw new Error("could not start the local database");
    },
  });
  eq(
    await new SetupService(failing.deps).createDatabase(),
    { outcome: "failed", reason: "could not start the local database" },
    "install fails: failed, with the reason — a result, not a throw",
  );
}

// ===========================================================================
// 2. PlaidKeyVerifier
// ===========================================================================

const SECRET = "s3cr3t-that-must-not-leak";
const client = (): unknown => (globalThis as Record<string, unknown>)["__costinglyClient"];
const rememberClient = (): void => {
  (globalThis as Record<string, unknown>)["__costinglyClient"] = { stale: true };
};

// What the Plaid SDK throws when Plaid answers with an error: an axios error
// whose response carries Plaid's body — and whose config carries the secret.
const refused = Object.assign(new Error("Request failed with status code 400"), {
  response: {
    data: {
      error_type: "INVALID_INPUT",
      error_code: "INVALID_API_KEYS",
      error_message: "invalid client_id or secret provided",
    },
  },
  config: { headers: { "PLAID-SECRET": SECRET } },
});

{
  const env: NodeJS.ProcessEnv = {};
  rememberClient();
  let sawDuringCheck: Array<string | undefined> = [];
  const verifier = new PlaidKeyVerifier({
    env,
    check: async () => {
      sawDuringCheck = [env["PLAID_CLIENT_ID"], env["PLAID_SECRET"]];
      ok(client() === undefined, "the remembered Plaid client is dropped before the check");
    },
  });
  eq(await verifier.verify("id", SECRET), { accepted: true }, "the check passes: accepted");
  eq(sawDuringCheck, ["id", SECRET], "the check ran with the offered keys in effect");
  eq([env["PLAID_CLIENT_ID"], env["PLAID_SECRET"]], ["id", SECRET], "accepted keys stay in effect");
}
{
  const env: NodeJS.ProcessEnv = {};
  const verdict = await new PlaidKeyVerifier({
    env,
    check: async () => {
      throw refused;
    },
  }).verify("id", SECRET);
  ok(!verdict.accepted && verdict.kind === "rejected", "Plaid answers with an error: rejected");
  ok(JSON.stringify(verdict).includes("INVALID_API_KEYS"), "the reason is Plaid's own");
  ok(!JSON.stringify(verdict).includes(SECRET), "THE SECRET IS NOT IN THE VERDICT");
  eq([env["PLAID_CLIENT_ID"], env["PLAID_SECRET"]], [undefined, undefined], "REJECTED KEYS ARE NOT LEFT IN EFFECT");
}
{
  const env: NodeJS.ProcessEnv = { PLAID_CLIENT_ID: "earlier-id", PLAID_SECRET: "earlier-secret" };
  rememberClient();
  await new PlaidKeyVerifier({
    env,
    check: async () => {
      throw refused;
    },
  }).verify("id", SECRET);
  eq(
    [env["PLAID_CLIENT_ID"], env["PLAID_SECRET"]],
    ["earlier-id", "earlier-secret"],
    "keys that were in effect before a rejection are put back",
  );
  ok(client() === undefined, "and the client built from the rejected pair is dropped too");
}
{
  const verdict = await new PlaidKeyVerifier({
    env: {},
    check: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND production.plaid.com"), {
        config: { headers: { "PLAID-SECRET": SECRET } },
      });
    },
  }).verify("id", SECRET);
  ok(!verdict.accepted && verdict.kind === "unreachable", "no answer at all: unreachable");
  ok(JSON.stringify(verdict).includes("ENOTFOUND"), "the reason says what failed");
  ok(!JSON.stringify(verdict).includes(SECRET), "and the secret is not in that verdict either");
}
{
  const started = Date.now();
  const verdict = await new PlaidKeyVerifier({
    env: {},
    timeoutMs: 50,
    check: () => new Promise(() => {}),
  }).verify("id", SECRET);
  ok(!verdict.accepted && verdict.kind === "unreachable", "a Plaid that never answers: unreachable");
  ok(!verdict.accepted && verdict.reason.includes("no response"), "…and says it timed out");
  ok(Date.now() - started < 5_000, "…after the time limit, not forever");
}
eq(classifyKeyFailure("plain string").kind, "unreachable", "a non-Error throw is unreachable, not a crash");

// ===========================================================================
// 3. DatabaseLifetimeService
// ===========================================================================

function datastore(state: DatastoreState | (() => never)) {
  const calls: string[] = [];
  return {
    calls,
    status: async (): Promise<DatastoreState> => (typeof state === "function" ? state() : state),
    start: async (): Promise<void> => void calls.push("start"),
    stop: async (): Promise<boolean> => {
      calls.push("stop");
      return true;
    },
  };
}
const logged: string[] = [];
const log = (line: string): void => void logged.push(line);

{
  const none = datastore("uninitialised");
  await new DatabaseLifetimeService(none, log).start();
  eq(none.calls, [], "no database: start does nothing — it must never create one");
  await new DatabaseLifetimeService(none, log).stop();
  eq(none.calls, [], "no database: stop does nothing");
}
{
  const stopped = datastore("stopped");
  await new DatabaseLifetimeService(stopped, log).start();
  eq(stopped.calls, ["start"], "a stopped database is started");
  await new DatabaseLifetimeService(stopped, log).stop();
  eq(stopped.calls, ["start"], "…and a stopped one is not asked to stop");
}
{
  const running = datastore("running");
  await new DatabaseLifetimeService(running, log).stop();
  eq(running.calls, ["stop"], "a running database is stopped");
}
{
  const broken = datastore(() => {
    throw new Error("pg_ctl: not found");
  });
  logged.length = 0;
  await new DatabaseLifetimeService(broken, log).start();
  await new DatabaseLifetimeService(broken, log).stop();
  ok(true, "a datastore that cannot be asked does not throw — the app still opens, and still quits");
  eq(logged.length, 2, "and both failures are logged");
}

// ===========================================================================
// 4. CloseNoticeService
// ===========================================================================

{
  let stored = { closeNoticeShown: false };
  const settings = {
    read: async () => ({ ...stored }),
    update: async (changes: Partial<typeof stored>) => {
      stored = { ...stored, ...changes };
    },
  };
  let shown = 0;
  let recordedBeforeShown = false;
  const notice = new CloseNoticeService(settings, () => {
    shown++;
    recordedBeforeShown = stored.closeNoticeShown;
  });

  await notice.windowHidden();
  eq(shown, 1, "the first close shows the notice");
  eq(recordedBeforeShown, true, "and it was recorded BEFORE it was shown — at most once, even if showing fails");
  await notice.windowHidden();
  await notice.windowHidden();
  eq(shown, 1, "later closes do not");
}

// ===========================================================================
// 5. SettingsService
// ===========================================================================

{
  const dir = join(HOME, "settings");
  const path = join(dir, "nested", "settings.json");
  const settings = new SettingsService(path);

  eq(await settings.read(), { closeNoticeShown: false }, "no file: the defaults");
  eq(existsSync(dir), false, "reading created nothing");

  await settings.update({ closeNoticeShown: true });
  eq(await settings.read(), { closeNoticeShown: true }, "an update is read back, and its folder was created");

  await writeFile(path, "{ not json");
  eq(await settings.read(), { closeNoticeShown: false }, "a corrupt file: the defaults, not a throw");
  await writeFile(path, JSON.stringify({ closeNoticeShown: "yes" }));
  eq(await settings.read(), { closeNoticeShown: false }, "a wrong-typed value: the default for it");
  await rm(dir, { recursive: true, force: true });
}

// ===========================================================================
// 6. The real wiring — the same service, over the real domain
// ===========================================================================

await rm(HOME, { recursive: true, force: true });
const real = new SetupService(domain.setupDependencies());

const nothing = await real.state();
eq(nothing.keysPresent, false, "real profile, nothing installed: no keys");
eq(nothing.databaseCreated, false, "real profile, nothing installed: no database");
ok(nothing.dataFolder.includes("costingly-desktop-services"), "the data folder is named");
eq(existsSync(HOME), false, "ASKING CREATED NOTHING");

// Claude Desktop's unfilled placeholder is not a key. The config layer already
// knows this; setup must inherit it rather than count the literal as present.
process.env["PLAID_CLIENT_ID"] = "${user_config.plaid_client_id}";
process.env["PLAID_SECRET"] = "${user_config.plaid_secret}";
eq((await real.state()).keysPresent, false, "an unfilled ${user_config…} placeholder is not keys");
delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];

await mkdir(HOME, { recursive: true });
configStore.update({ plaidClientId: "client-id-only" });
eq((await real.state()).keysPresent, false, "real profile: a client ID without a secret is not keys");
configStore.update({ plaidSecret: "a-secret" });
const keyed = await real.state();
eq(keyed.keysPresent, true, "real profile: both keys saved, keys present");
eq(keyed.databaseCreated, false, "…and still no database — the two are independent");

await rm(HOME, { recursive: true, force: true });

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
