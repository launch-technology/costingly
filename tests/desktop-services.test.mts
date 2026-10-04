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
 *   3. DatabaseService        tells failures apart from evidence; one thing at
 *                             a time; never throws
 *   4. DatabaseLog            the tail, only what is new, and nothing secret
 *   5. CloseNoticeService     once
 *   6. SettingsService        forgiving on read
 *   7. The real wiring        the same service over the real domain, on a
 *                             throwaway profile — asking must create nothing
 *
 * Runs on every platform: nothing here imports Electron, which the
 * architecture suite enforces.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = join(tmpdir(), "costingly-desktop-services");
process.env["COSTINGLY_HOME"] = HOME;
delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { configStore } = await import("../src/index.js");
const { SetupService } = await import("../src/apps/desktop/main/services/setup.service.js");
const { DatabaseService } = await import("../src/apps/desktop/main/services/database.service.js");
const { DatabaseLog, createRedactor } = await import("../src/apps/desktop/main/adapters/database-log.js");
const { databaseSectionReader } = await import("../src/apps/desktop/main/controllers/database.controller.js");
const { CloseNoticeService } = await import("../src/apps/desktop/main/services/close-notice.service.js");
const { SettingsService } = await import("../src/apps/desktop/main/services/settings.service.js");
const { PlaidKeyVerifier, classifyKeyFailure } = await import(
  "../src/apps/desktop/main/adapters/plaid-key-verifier.js"
);
const domain = await import("../src/apps/desktop/main/adapters/domain.js");
const { PlaidClient } = await import("../src/domain/data/plaid.client.js");
const { createLinkToken } = await import("../src/domain/services/banks/link.service.js");

type SetupDependencies = import("../src/apps/desktop/main/services/setup.service.js").SetupDependencies;
type KeyVerdict = import("../src/apps/desktop/main/services/setup.service.js").KeyVerdict;
type DatabaseDependencies = import("../src/apps/desktop/main/services/database.service.js").DatabaseDependencies;
type Problem = import("../src/apps/desktop/bridge/contract.js").Problem;
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
  keysPresent?: boolean;
  verdict?: KeyVerdict;
  existingKey?: string;
  /** What creating the database reports. Nothing means it worked. */
  creationProblem?: Problem;
  write?: () => Promise<void>;
  dataDirExists?: boolean;
} = {}): Fake {
  const written: StoredConfig[] = [];
  const verified: Array<[string, string]> = [];

  const deps: SetupDependencies = {
    datastore: {
      status: overrides.status ?? (async () => "uninitialised"),
      dataDir: () => "/profile/pg18",
    },
    keysPresent: () => overrides.keysPresent ?? false,
    config: {
      readFile: () => (overrides.existingKey === undefined ? {} : { encryptionKey: overrides.existingKey }),
      write:
        overrides.write ??
        (async (values) => {
          written.push(values);
        }),
    },
    keys: {
      verify: async (clientId, secret) => {
        verified.push([clientId, secret]);
        return overrides.verdict ?? { accepted: true };
      },
    },
    createDatabase: async () => overrides.creationProblem,
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
  const { deps } = fake({ keysPresent: true });
  eq((await new SetupService(deps).state()).keysPresent, true, "keys in place: keys present");
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
    [{ plaidClientId: "id", plaidSecret: "secret", encryptionKey: "freshly-generated-key" }],
    "saved once: the keys and a new encryption key — and nothing about which Plaid",
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
  eq(await new SetupService(fake().deps).createDatabase(), { outcome: "ready" }, "creation succeeds: ready");
  const problem = { cause: "Another program is using port 54320.", nextStep: "Close that program." };
  eq(
    await new SetupService(fake({ creationProblem: problem }).deps).createDatabase(),
    { outcome: "failed", problem },
    "creation fails: failed, carrying the explanation as given — a result, not a throw",
  );
}

// ===========================================================================
// 2. PlaidKeyVerifier
// ===========================================================================

const SECRET = "s3cr3t-that-must-not-leak";

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
  let offered: string[] = [];
  const envBefore = [process.env["PLAID_CLIENT_ID"], process.env["PLAID_SECRET"]];
  const verifier = new PlaidKeyVerifier({
    check: async (clientId, secret) => {
      offered = [clientId, secret];
    },
  });
  eq(await verifier.verify("id", SECRET), { accepted: true }, "the check passes: accepted");
  eq(offered, ["id", SECRET], "the check was handed the pair being offered");
  eq(
    [process.env["PLAID_CLIENT_ID"], process.env["PLAID_SECRET"]],
    envBefore,
    "VERIFYING TOUCHES NOTHING — the keys are not put anywhere; they take effect only once saved",
  );
}
{
  const verdict = await new PlaidKeyVerifier({
    check: async () => {
      throw refused;
    },
  }).verify("id", SECRET);
  ok(!verdict.accepted && verdict.kind === "rejected", "Plaid answers with an error: rejected");
  ok(JSON.stringify(verdict).includes("INVALID_API_KEYS"), "the reason is Plaid's own");
  ok(!JSON.stringify(verdict).includes(SECRET), "THE SECRET IS NOT IN THE VERDICT");
}
{
  const verdict = await new PlaidKeyVerifier({
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
    timeoutMs: 50,
    check: () => new Promise(() => {}),
  }).verify("id", SECRET);
  ok(!verdict.accepted && verdict.kind === "unreachable", "a Plaid that never answers: unreachable");
  ok(!verdict.accepted && verdict.reason.includes("no response"), "…and says it timed out");
  ok(Date.now() - started < 5_000, "…after the time limit, not forever");
}
eq(classifyKeyFailure("plain string").kind, "unreachable", "a non-Error throw is unreachable, not a crash");

// --- the Plaid client itself: which Plaid is decided by who builds it ----------
{
  const serverOf = (client: InstanceType<typeof PlaidClient>): string =>
    (client.api as unknown as { basePath: string }).basePath;

  const product = PlaidClient.withKeys("id", "secret");
  eq(product.server, "production", "a client is production unless its builder says otherwise");
  ok(serverOf(product).includes("production.plaid.com"), "and talks to Plaid's production server");

  const forTests = PlaidClient.withKeys("id", "secret", "sandbox");
  ok(serverOf(forTests).includes("sandbox.plaid.com"), "a client built in sandbox mode talks to Plaid's sandbox");

  process.env["PLAID_ENV"] = "sandbox";
  ok(
    serverOf(PlaidClient.withKeys("id", "secret")).includes("production.plaid.com"),
    "PLAID_ENV IN THE ENVIRONMENT CHANGES NOTHING — no setting chooses the server",
  );
  delete process.env["PLAID_ENV"];

  let keys = { clientId: "first-id", secret: "first-secret" };
  const following = new PlaidClient({ credentials: () => keys });
  const before = following.api;
  eq(following.api === before, true, "the SDK client is reused while the keys are unchanged");
  keys = { clientId: "second-id", secret: "second-secret" };
  eq(following.api === before, false, "and rebuilt when they change — no restart, nothing to tell it");

  eq(following.hasCredentials(), true, "a client with both keys has credentials");
  keys = { clientId: "", secret: "x" };
  eq(following.hasCredentials(), false, "a blank key is not credentials");
  const none = new PlaidClient({
    credentials: () => {
      throw new Error("PLAID_CLIENT_ID is not set.");
    },
  });
  eq(none.hasCredentials(), false, "a client whose keys are missing says so without throwing");
}

// --- real keys, when this machine has them ---------------------------------------
//
// Plaid's sandbox keys, read from the test keys file. Offered twice: to a check
// THIS SUITE builds in sandbox mode, and to the product's own check.
{
  const keysFile = join(fileURLToPath(new URL("..", import.meta.url)), ".dev-sandbox", "config.json");
  if (!existsSync(keysFile)) {
    out.push("  --    sandbox keys NOT TRIED: no .dev-sandbox/config.json (npm run setup:sandbox)");
  } else {
    const sandbox = JSON.parse(readFileSync(keysFile, "utf8")) as { plaidClientId: string; plaidSecret: string };

    const sandboxVerifier = new PlaidKeyVerifier({
      check: (clientId, secret) => createLinkToken(PlaidClient.withKeys(clientId, secret, "sandbox")),
    });
    eq(
      await sandboxVerifier.verify(sandbox.plaidClientId, sandbox.plaidSecret),
      { accepted: true },
      "real sandbox keys are accepted by a check built in sandbox mode",
    );

    const productVerdict = await new PlaidKeyVerifier({ check: domain.keyCheck }).verify(
      sandbox.plaidClientId,
      sandbox.plaidSecret,
    );
    ok(
      !productVerdict.accepted && productVerdict.kind === "rejected",
      "THE PRODUCT'S OWN CHECK REJECTS SANDBOX KEYS — it can only ask production",
    );

    // The whole of setup's keys step, for real: sandbox check, real config.
    await rm(HOME, { recursive: true, force: true });
    const setup = new SetupService({
      ...domain.setupDependencies(),
      keys: sandboxVerifier,
      createDatabase: async () => undefined,
    });
    eq(
      await setup.submitKeys(sandbox.plaidClientId, sandbox.plaidSecret),
      { outcome: "accepted" },
      "setup accepts keys its verifier accepts",
    );
    const saved = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")) as Record<string, unknown>;
    eq(
      [saved["plaidClientId"], saved["plaidSecret"]],
      [sandbox.plaidClientId, sandbox.plaidSecret],
      "and saves them to the profile",
    );
    ok(typeof saved["encryptionKey"] === "string" && saved["encryptionKey"] !== "", "with a new encryption key");
    eq(Object.keys(saved).includes("plaidEnv"), false, "and NO Plaid environment — there is no such setting");
    eq((await setup.state()).keysPresent, true, "after which the keys are present");
    await rm(HOME, { recursive: true, force: true });
  }
}

// ===========================================================================
// 3. DatabaseService
// ===========================================================================

/** A database that exists only as far as the service can tell. */
interface World {
  state: DatastoreState;
  /** What the database's log holds. Appended to, like the real one. */
  log: string;
  /** Is anything answering on the port — ours or somebody else's. */
  serving: boolean;
  calls: string[];
  reports: string[];
}

function database(options: {
  state?: DatastoreState;
  log?: string;
  serving?: boolean;
  keysPresent?: boolean;
  status?: (world: World) => Promise<DatastoreState>;
  start?: (world: World) => Promise<void>;
  update?: (world: World) => Promise<void>;
  create?: (world: World) => Promise<void>;
} = {}): { world: World; service: InstanceType<typeof DatabaseService> } {
  const world: World = {
    state: options.state ?? "stopped",
    log: options.log ?? "",
    serving: options.serving ?? false,
    calls: [],
    reports: [],
  };

  const deps: DatabaseDependencies = {
    datastore: {
      status: () => (options.status ? options.status(world) : Promise.resolve(world.state)),
      start: async () => {
        world.calls.push("start");
        if (options.start) await options.start(world);
        else world.state = "running";
      },
      stop: async () => {
        world.calls.push("stop");
        world.state = "stopped";
        return true;
      },
      isServing: async () => world.serving,
      endpoint: async () => ({ host: "127.0.0.1", port: 54320 }),
    },
    update: async () => {
      world.calls.push("update");
      await options.update?.(world);
    },
    create: async () => {
      world.calls.push("create");
      if (options.create) await options.create(world);
      else world.state = "running";
    },
    log: {
      size: async () => world.log.length,
      readSince: async (offset) => world.log.slice(offset),
    },
    closeConnections: async () => void world.calls.push("close"),
    keysPresent: () => options.keysPresent ?? true,
    // Stands in for the real one, which removes secrets: the service must use
    // this for every reason it keeps, and never the error itself.
    describeError: (error) =>
      (error instanceof Error ? error.message : String(error)).replace("hunter2", "[hidden]"),
    report: (line) => void world.reports.push(line),
  };

  return { world, service: new DatabaseService(deps) };
}

const failToStart = async (): Promise<void> => {
  throw new Error("Could not start the local database. password hunter2");
};

// --- at launch ---------------------------------------------------------------
{
  const { world, service } = database({ state: "uninitialised" });
  await service.bringUp();
  eq(world.calls, [], "no database: nothing is started — and NOTHING IS CREATED");
  eq(service.lastFailure(), undefined, "and that is not a failure");
}
{
  const { world, service } = database({ state: "stopped" });
  await service.bringUp();
  eq(world.calls, ["start", "update"], "a set-up machine: the database is started, then its tables brought up to date");
  eq(service.lastFailure(), undefined, "with no failure");
}
{
  const { world, service } = database({ state: "stopped", keysPresent: false });
  await service.bringUp();
  eq(world.calls, ["start"], "a machine without keys: started, but NOT updated — setup has not finished with it");
}
{
  const { world, service } = database({ state: "running" });
  await service.bringUp();
  eq(world.calls, ["start", "update"], "a database left running by a crash is simply used: start is asked and is a no-op underneath");
  eq(service.lastFailure(), undefined, "and it is not a failure");
}

// --- telling a failed start apart ---------------------------------------------
{
  const { service } = database({ start: failToStart, serving: true });
  await service.bringUp();
  const failure = service.lastFailure();
  eq(failure?.kind, "port-in-use", "start fails while something answers on the port: port in use");
  eq(failure?.kind === "port-in-use" ? failure.port : null, 54320, "and the port is named");
}
{
  const { service } = database({
    start: async (world) => {
      world.log += 'LOG:  could not bind IPv4 address "127.0.0.1": Only one usage of each socket address\n';
      throw new Error("pg_ctl: could not start server");
    },
  });
  await service.bringUp();
  eq(service.lastFailure()?.kind, "port-in-use", "start fails and the log written DURING the attempt says it could not bind: port in use");
}
{
  const { service } = database({
    log: 'LOG:  could not bind IPv4 address "127.0.0.1": Only one usage of each socket address\n',
    start: async (world) => {
      world.log += "FATAL:  could not open file global/pg_control\n";
      throw new Error("pg_ctl: could not start server");
    },
  });
  await service.bringUp();
  eq(
    service.lastFailure()?.kind,
    "will-not-start",
    "AN OLD BIND MESSAGE ALREADY IN THE LOG DOES NOT MAKE TODAY'S FAILURE A PORT CONFLICT",
  );
}
{
  const { service } = database({
    start: async (world) => {
      world.state = "running";
      throw new Error("password authentication failed");
    },
  });
  await service.bringUp();
  eq(service.lastFailure()?.kind, "not-answering", "start fails but the server is in fact running: not answering, not 'will not start'");
}
{
  const { world, service } = database({ start: failToStart });
  await service.bringUp();
  const failure = service.lastFailure();
  eq(failure?.kind, "will-not-start", "any other failed start: will not start");
  ok((failure?.reason ?? "").includes("Could not start the local database"), "with the reason it was given");
  ok(!(failure?.reason ?? "").includes("hunter2"), "THE REASON WENT THROUGH THE REDACTING DESCRIBER, NOT THE RAW ERROR");
  eq(world.calls, ["start"], "and the update was not attempted on a server that is down");
  eq(world.reports.length, 1, "the failure is logged once");
}
{
  const { world, service } = database({
    update: async () => {
      throw new Error('column "source" already exists');
    },
  });
  await service.bringUp();
  eq(service.lastFailure()?.kind, "update-failed", "the server starts but the update fails: update failed");
  eq(world.state, "running", "and the server is left running");
}

// --- a success clears what was remembered --------------------------------------
{
  let broken = true;
  const { service } = database({
    start: async (world) => {
      if (broken) throw new Error("pg_ctl: could not start server");
      world.state = "running";
    },
  });
  await service.bringUp();
  eq(service.lastFailure()?.kind, "will-not-start", "a failure is remembered…");
  broken = false;
  await service.start();
  eq(service.lastFailure(), undefined, "…UNTIL THE NEXT SUCCESS CLEARS IT");
}

// --- the controls ------------------------------------------------------------
{
  const { world, service } = database({ state: "running" });
  await service.stop();
  eq(world.calls, ["close", "stop"], "Stop: this process's connections are closed first, then the server stopped");
  eq(service.lastFailure(), undefined, "stopped on request is not a failure");
}
{
  const { world, service } = database({ state: "stopped" });
  await service.stop();
  eq(world.calls, ["close"], "Stop on a database that is not running: nothing to stop");
}
{
  const { world, service } = database({ state: "running" });
  await service.restart();
  eq(world.calls, ["close", "stop", "start", "update"], "Restart: close, stop, start, update — in that order");
  eq(world.state, "running", "and it ends up running");
}

// --- one thing at a time ------------------------------------------------------
{
  const { world, service } = database({
    state: "stopped",
    start: async (w) => {
      w.calls.push("start:slow…");
      await new Promise((resolve) => setTimeout(resolve, 60));
      w.state = "running";
      w.calls.push("…start:done");
    },
  });
  // Quit arrives while a start is still in progress.
  const starting = service.start();
  const stopping = service.stop();
  await Promise.all([starting, stopping]);
  eq(
    world.calls,
    ["start", "start:slow…", "…start:done", "update", "close", "stop"],
    "A STOP REQUESTED DURING A START WAITS FOR IT, THEN STOPS WHAT IT STARTED",
  );
  eq(world.state, "stopped", "so the database is not left running behind a quit");
}

// --- nothing throws ------------------------------------------------------------
{
  const { world, service } = database({
    status: async () => {
      throw new Error("pg_ctl: not found");
    },
  });
  await service.bringUp();
  await service.stop();
  await service.restart();
  ok(true, "a datastore that cannot even be asked: bring up, stop and restart all resolve — the app still opens, and still quits");
  eq(service.lastFailure()?.kind, "will-not-start", "and what is remembered says why");
  ok(world.reports.length >= 2, "with each failure logged");
}

// --- creating ------------------------------------------------------------------
{
  const { world, service } = database({ state: "uninitialised" });
  eq(await service.create(), undefined, "create on a machine with no database: no failure");
  eq(world.state, "running", "and it is running afterwards");
}
{
  const { service } = database({
    state: "uninitialised",
    create: async () => {
      throw new Error("initdb: could not create directory");
    },
  });
  eq((await service.create())?.kind, "create-failed", "creation fails with still no database: create failed");
  eq(service.lastFailure()?.kind, "create-failed", "and it is remembered for the status screen too");
}
{
  const { service } = database({
    state: "uninitialised",
    serving: true,
    create: async (world) => {
      world.state = "stopped";
      throw new Error("pg_ctl: could not start server");
    },
  });
  eq((await service.create())?.kind, "port-in-use", "the database is created but will not start because the port is taken: port in use");
}
{
  const { service } = database({
    state: "uninitialised",
    create: async (world) => {
      world.state = "running";
      throw new Error("migration 0002 failed");
    },
  });
  eq((await service.create())?.kind, "update-failed", "the database is created and started but its tables are not: update failed");
}

// --- reading the section does not wait on somebody else's program --------------
{
  type DatabaseHealth = import("../src/domain/services/database/database-health.service.js").DatabaseHealth;
  const runningHealth: DatabaseHealth = {
    profile: { path: "~/p", chosenBy: "platform default", exists: true },
    cluster: {
      path: "~/p/pg18",
      exists: true,
      state: "running",
      listenAddress: "127.0.0.1:54320",
      startedAt: "2026-10-03 09:00",
      uptimeSeconds: 10,
    },
    connection: { ok: true, elapsedMs: 5 },
    migrationsApplied: ["0001-initial"],
  };
  const portInUse = { kind: "port-in-use", reason: "pg_ctl: could not start server", port: 54320 } as const;

  // The health check logs in to whatever holds the port. Here it never returns,
  // as it would not against a program that accepts the connection and says nothing.
  const hangs = (): Promise<DatabaseHealth> => new Promise(() => {});
  const waited = Symbol("waited");
  const stuck = databaseSectionReader(
    { health: hangs, state: async () => "stopped" },
    { lastFailure: () => portInUse },
  );
  const prompt = await Promise.race([
    stuck(),
    new Promise<typeof waited>((resolve) => setTimeout(() => resolve(waited), 2_000)),
  ]);
  ok(prompt !== waited, "A KNOWN START FAILURE IS REPORTED WITHOUT RUNNING THE HEALTH CHECK");
  eq(prompt !== waited ? prompt.headline : null, "Port in use", "and it is the failure that is shown");

  let asked = 0;
  const health = async (): Promise<DatabaseHealth> => {
    asked++;
    return runningHealth;
  };
  const recovered = await databaseSectionReader(
    { health, state: async () => "running" },
    { lastFailure: () => portInUse },
  )();
  eq([recovered.headline, asked], ["Running", 1], "once the server is up, the health check is used and the remembered failure dropped");

  const normal = await databaseSectionReader({ health, state: async () => "running" }, { lastFailure: () => undefined })();
  eq(normal.headline, "Running", "with nothing remembered, the health check is the answer");

  const broken = await databaseSectionReader(
    {
      health: async () => {
        throw new Error("the check itself blew up");
      },
      state: async () => "running",
    },
    { lastFailure: () => undefined },
  )();
  eq([broken.headline, broken.actions], ["Could not check", []], "a health check that throws is a section that says so, with nothing to press");
}

// ===========================================================================
// 4. DatabaseLog, and what it will not show
// ===========================================================================

{
  const dir = join(HOME, "logs");
  const path = join(dir, "pg18.log");
  await mkdir(dir, { recursive: true });

  const DB_PASSWORD = "p4ssw0rd-generated-value";
  const redact = createRedactor(() => [DB_PASSWORD, "plaid-secret-value", undefined, "abc"]);
  const log = new DatabaseLog({ path: () => path, displayPath: (p) => `shown:${p}`, redact });

  // --- no log yet ---
  eq(await log.size(), 0, "no log file: size is zero");
  eq(await log.readSince(0), "", "and nothing has been written since anything");
  eq(await log.excerpt(), { state: "empty", path: `shown:${path}` }, "and the excerpt says so, with the display path — an answer, not an error");

  // --- the tail ---
  const forty = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\r\n") + "\r\n";
  await writeFile(path, forty);
  const excerpt = await log.excerpt();
  eq(excerpt.state, "lines", "a log with content: lines");
  if (excerpt.state === "lines") {
    eq(excerpt.lines.length, 30, "the last 30 lines, no more");
    eq([excerpt.lines[0], excerpt.lines[29]], ["line 11", "line 40"], "the LAST thirty, in order, without line endings");
    eq(excerpt.path, `shown:${path}`, "with the path as a person should see it");
  }

  await writeFile(path, "only\nthree\nlines\n");
  const short = await log.excerpt();
  eq(short.state === "lines" ? short.lines : null, ["only", "three", "lines"], "a short log is returned whole");

  // --- only what is new ---
  const mark = await log.size();
  await writeFile(path, "only\nthree\nlines\nwritten during the attempt\n");
  eq(await log.readSince(mark), "written during the attempt\n", "readSince returns only what was appended after the mark");
  await writeFile(path, "replaced\n");
  eq(await log.readSince(mark), "replaced\n", "a log replaced by a shorter one is all new");

  // --- nothing secret ---
  await writeFile(
    path,
    [
      "ERROR:  tuple concurrently updated",
      `STATEMENT:  ALTER ROLE costingly_app LOGIN PASSWORD '${DB_PASSWORD}'`,
      "STATEMENT:  alter role other password 'something-else-entirely'",
      "LOG:  connection authorized using plaid-secret-value somehow",
      "LOG:  the word abc is too short to be treated as a secret",
    ].join("\n") + "\n",
  );
  const shown = await log.excerpt();
  const text = shown.state === "lines" ? shown.lines.join("\n") : "";
  ok(!text.includes(DB_PASSWORD), "THE DATABASE PASSWORD IN A LOGGED STATEMENT IS NOT SHOWN");
  ok(!text.includes("something-else-entirely"), "nor is any other password-setting statement's value, known or not");
  ok(text.includes("PASSWORD '[hidden]'"), "the statement is kept, with the value blanked");
  ok(!text.includes("plaid-secret-value"), "a stored secret is blanked wherever it appears");
  ok(text.includes("abc"), "a value too short to be a secret is left alone");
  ok(text.includes("tuple concurrently updated"), "and everything else is shown as written");
  ok(!(await log.readSince(0)).includes(DB_PASSWORD), "what the service reads as evidence is redacted too");

  await rm(dir, { recursive: true, force: true });
}

// ===========================================================================
// 5. CloseNoticeService
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
// 6. SettingsService
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
// 7. The real wiring — the same service, over the real domain
// ===========================================================================

await rm(HOME, { recursive: true, force: true });
const real = new SetupService({ ...domain.setupDependencies(), createDatabase: async () => undefined });

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
