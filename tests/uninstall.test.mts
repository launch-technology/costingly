/**
 * Uninstall — deleting a profile, and coming back from it.
 *
 * Two things are being proved, and the second is the one that matters to
 * anyone testing a release:
 *
 *   1. The guard refuses anything that is not a profile. The path comes from
 *      COSTINGLY_HOME, so a typo can point the delete at a home directory.
 *      These assertions are the reason that is survivable.
 *   2. A profile can be removed while its server is RUNNING, and the next
 *      query rebuilds the whole thing from nothing. That round trip is the
 *      actual feature: uninstall, then reinstall from scratch.
 *
 * Revocation is deliberately untested here — it needs Plaid, and the suites
 * that talk to Plaid skip without sandbox credentials. What is tested is that
 * `--local-only` never reaches for it.
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join } from "node:path";

const HOME = "/tmp/costingly-uninstall";
process.env["COSTINGLY_HOME"] = HOME;

// Present so nothing falls back to a real profile's credentials. Never used:
// every path exercised below is --local-only.
process.env["PLAID_CLIENT_ID"] = "client-id-for-uninstall-suite";
process.env["PLAID_SECRET"] = "secret-for-uninstall-suite";

const { db, closeDb, server } = await import("../src/index.js");
const { removeProfile, projectParentOf } = await import("../src/platform/profile.js");
const { resolvePlatform } = await import("../src/platform/platform-config.js");
const { platform: costinglyPlatform } = await import("../src/domain/project.js");
const { uninstall } = await import("../src/domain/services/uninstall.service.js");

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

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Whatever this run leaves behind must not outlive it. */
async function wipe(): Promise<void> {
  await server.stop().catch(() => {});
  await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
await wipe();

/**
 * A server that fails the test if it is touched.
 *
 * Every guard below must reject BEFORE anything is stopped — a guard that
 * shuts down a database on its way to refusing has already done damage.
 */
let stopCalled = false;
const forbiddenServer = {
  stop: async (): Promise<boolean> => {
    stopCalled = true;
    return false;
  },
  isServing: async (): Promise<boolean> => false,
} as unknown as Parameters<typeof removeProfile>[1];

/** A server that claims to have stopped while something is still answering. */
const lyingServer = {
  stop: async (): Promise<boolean> => false,
  isServing: async (): Promise<boolean> => true,
} as unknown as Parameters<typeof removeProfile>[1];

/** A platform config pointed wherever the test needs it. */
function platformAt(dir: string): ReturnType<typeof resolvePlatform> {
  return resolvePlatform({ name: "costingly", ports: { database: 54320 } }, {
    COSTINGLY_HOME: dir,
  } as NodeJS.ProcessEnv);
}

// ===========================================================================
// 1. The guard
// ===========================================================================

// --- a directory that is not a profile ------------------------------------
const notAProfile = "/tmp/costingly-uninstall-decoy";
await rm(notAProfile, { recursive: true, force: true });
await mkdir(notAProfile, { recursive: true });
await writeFile(join(notAProfile, "important.txt"), "someone else's data");

let refused = "";
try {
  await removeProfile(platformAt(notAProfile), forbiddenServer);
} catch (error) {
  refused = error instanceof Error ? error.message : String(error);
}
ok(refused.includes("does not look like a profile"), "refuses a directory with no profile marker");
ok(await exists(join(notAProfile, "important.txt")), "and the contents are still there");
eq(stopCalled, false, "the guard refused BEFORE stopping any server");
await rm(notAProfile, { recursive: true, force: true });

// --- the home directory ----------------------------------------------------
refused = "";
try {
  await removeProfile(platformAt(homedir()), forbiddenServer);
} catch (error) {
  refused = error instanceof Error ? error.message : String(error);
}
ok(refused.includes("home directory"), "refuses the home directory by name");
eq(stopCalled, false, "still nothing stopped");

// --- a filesystem root -----------------------------------------------------
refused = "";
try {
  await removeProfile(platformAt("/"), forbiddenServer);
} catch (error) {
  refused = error instanceof Error ? error.message : String(error);
}
ok(refused.includes("filesystem root"), "refuses a filesystem root");
eq(stopCalled, false, "still nothing stopped");

// --- nothing there at all --------------------------------------------------
// "Already gone" is the state the caller asked for, so this reports rather than
// throwing — which is what makes uninstall safe to re-run after a failure.
const absent = await removeProfile(platformAt("/tmp/costingly-uninstall-absent"), forbiddenServer);
eq(absent.existed, false, "a missing profile is reported, not thrown");
eq(stopCalled, false, "and nothing was stopped for it");

// --- a config.json alone is enough ----------------------------------------
// A profile whose cluster was never created still belongs to us.
const configOnly = "/tmp/costingly-uninstall-configonly";
await rm(configOnly, { recursive: true, force: true });
await mkdir(configOnly, { recursive: true });
await writeFile(join(configOnly, "config.json"), "{}\n");
const removedConfigOnly = await removeProfile(platformAt(configOnly), forbiddenServer);
eq(removedConfigOnly.existed, true, "a profile with only config.json is recognised");
eq(await exists(configOnly), false, "and it is gone");

// ===========================================================================
// 1b. The enclosing directory, where the platform nests one
// ===========================================================================
//
// Windows puts the profile at <LOCALAPPDATA>\<name>\Data, so deleting only the
// profile leaves an empty <name> folder — an uninstall that did not uninstall.
// macOS and Linux do not nest, and their parent is a SHARED system folder that
// must never be touched.
//
// Decided against a FABRICATED project, so this reasons about the real
// platform-native layout without a filesystem anywhere near a real profile.

const { resolvePlatform: resolveFake } = await import("../src/platform/platform-config.js");
const fake = resolveFake({ name: "drive-rag", ports: { database: 1 } }, {} as NodeJS.ProcessEnv);
const fakeParent = projectParentOf(fake, fake.profileDir());

if (osPlatform() === "win32") {
  eq(fakeParent, dirname(fake.profileDir()), "Windows: the project-named parent is removable");
  eq(basename(fakeParent ?? ""), "drive-rag", "…and it is named for the PROJECT, not the platform");
} else {
  eq(fakeParent, null, "macOS/Linux: the parent is a shared system folder, never removed");
}

// A profile the USER placed: its parent is the user's directory, not ours.
const placed = resolveFake({ name: "drive-rag", ports: { database: 1 } }, {
  DRIVE_RAG_HOME: "/tmp/somewhere/my-profile",
} as NodeJS.ProcessEnv);
eq(projectParentOf(placed, placed.profileDir()), null,
   "a profile placed by the home variable never has its parent removed");

// Even when the user's own directory happens to be named for the project.
const coincidence = resolveFake({ name: "drive-rag", ports: { database: 1 } }, {
  DRIVE_RAG_HOME: "/tmp/drive-rag/inner",
} as NodeJS.ProcessEnv);
eq(projectParentOf(coincidence, coincidence.profileDir()), null,
   "…not even when that directory shares the project's name");

// ===========================================================================
// 2. The gate: a stop that did not stop must abort the delete
// ===========================================================================
//
// The failure this exists to prevent is silent. Deleting a data directory under
// a live postmaster does not raise an error — PostgreSQL opens its files with
// FILE_SHARE_DELETE, so the unlink succeeds and the server keeps running from
// handles whose files no longer have names. The cluster is destroyed, the pid
// file goes with it, and `pg_ctl` can no longer see the process to stop it.
//
// So `stop()` returning is not proof. `isServing()` is, and it must veto.

const stillServing = "/tmp/costingly-uninstall-live";
await rm(stillServing, { recursive: true, force: true });
await mkdir(stillServing, { recursive: true });
await writeFile(join(stillServing, "config.json"), "{}\n");

refused = "";
try {
  await removeProfile(platformAt(stillServing), lyingServer);
} catch (error) {
  refused = error instanceof Error ? error.message : String(error);
}
ok(refused.includes("still running"), "refuses to delete while the port still answers");
ok(refused.includes("quit it first"), "and says what the user should do about it");
eq(await exists(join(stillServing, "config.json")), true,
   "NOTHING WAS DELETED — the profile survives an unproven stop");
await rm(stillServing, { recursive: true, force: true });

// A real listener, not a stub: proves the probe itself detects one.
const { createServer } = await import("node:net");
const { createConfigStore } = await import("../src/platform/config-store.js");
const { createPostgresServer } = await import("../src/platform/postgres/server.js");
const { createPorts } = await import("../src/platform/ports.js");

const probeHome = "/tmp/costingly-uninstall-probe";
await rm(probeHome, { recursive: true, force: true });
await mkdir(probeHome, { recursive: true });

const listener = createServer();
const probePort = await new Promise<number>((done) => {
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    done(typeof address === "object" && address !== null ? address.port : 0);
  });
});

// Record that port as this profile's, exactly as the allocator would.
const probeConfig = platformAt(probeHome);
const probeStore = createConfigStore(probeConfig);
probeStore.writePorts({ database: probePort });
const probeServer = createPostgresServer(probeConfig, probeStore, createPorts(probeConfig, probeStore));

eq(await probeServer.isServing(), true, "isServing() sees a real listener on the recorded port");
await new Promise<void>((done) => listener.close(() => done()));
eq(await probeServer.isServing(), false, "and reports false once it closes");
await rm(probeHome, { recursive: true, force: true });

// ===========================================================================
// 3. The round trip — the actual feature
// ===========================================================================

// Build a real profile: this creates the cluster, applies the schema and leaves
// a postmaster running and holding handles inside the directory.
await db.query("SELECT 1");
ok(await exists(costinglyPlatform.configPath()), "a real profile was created");
ok(await exists(server.clusterDir()), "with a cluster in it");
eq(await server.status(), "running", "and a running server");

// --local-only: no Plaid, no credentials, no network.
const result = await uninstall({ revoke: false });

eq(result.outcomes, [], "--local-only revokes nothing");
eq(result.revokeError, undefined, "and reports no revoke failure, because none was attempted");
eq(result.profile.existed, true, "the profile was there");
eq(result.profile.serverWasRunning, true, "the RUNNING server was stopped on the way");
eq(await exists(HOME), false, "the profile directory is gone, postmaster handles and all");

// The assertion this suite exists for: after an uninstall, the next query
// rebuilds everything — initdb, the database, the schema, the runtime role.
const revived = await db.query<{ n: number }>("SELECT 1 AS n");
eq(revived.rows[0]?.n, 1, "REINSTALL FROM SCRATCH: the next query rebuilds the whole profile");
ok(await exists(costinglyPlatform.configPath()), "a fresh config.json was written");
eq((await db.query("SELECT count(*)::int AS n FROM items")).rows.length, 1,
   "and the schema is back — items is queryable");

await closeDb();
await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
